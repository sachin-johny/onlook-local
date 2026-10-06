"use client";

import type {
  Provider,
  ProviderTask,
  ProviderTerminal,
} from "@onlook/code-provider";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { v4 as uuidv4 } from "uuid";
import type { ErrorManager } from "../error";
// Dynamic imports to avoid SSR issues
let FitAddonClass: typeof FitAddon | null = null;
let TerminalClass: typeof Terminal | null = null;

export enum CLISessionType {
  TERMINAL = "terminal",
  TASK = "task",
}

export interface CLISession {
  id: string;
  name: string;
  type: CLISessionType;
  terminal: ProviderTerminal | null;
  // Task is readonly
  task: ProviderTask | null;
  xterm: Terminal | null;
  fitAddon: FitAddon | null;
}

export interface TaskSession extends CLISession {
  type: CLISessionType.TASK;
  task: ProviderTask;
}

export interface TerminalSession extends CLISession {
  type: CLISessionType.TERMINAL;
  terminal: ProviderTerminal;
}

/** Visual markers injected into the xterm buffer during reconnection */
const RECONNECT_MSG = "\r\n\x1b[33m⏳ Connection lost — reconnecting…\x1b[0m\r\n";
const RECONNECTED_MSG = "\r\n\x1b[32m✓ Reconnected\x1b[0m\r\n";
const RECONNECT_FAILED_MSG = "\r\n\x1b[31m✗ Reconnection failed — terminal session lost\x1b[0m\r\n";

export class CLISessionImpl implements CLISession {
  id: string;
  terminal: ProviderTerminal | null;
  task: ProviderTask | null;
  xterm: Terminal | null;
  fitAddon: FitAddon | null;

  /** Tracks whether we are in the middle of a reconnection attempt */
  private reconnecting = false;
  /** Subscription for ProviderTerminal connection state changes (if supported) */
  private stateUnsubscribe: (() => void) | null = null;
  /** Subscription for PtyClient reconnection events (if supported) */
  private reconnectUnsubscribe: (() => void) | null = null;
  /** Whether the last successful connection was a reclaimed (reconnected) session */
  private wasReclaimed = false;

  constructor(
    public readonly name: string,
    public readonly type: CLISessionType,
    private readonly provider: Provider,
    private readonly errorManager: ErrorManager,
    private readonly terminalOverride?: ProviderTerminal,
  ) {
    this.id = uuidv4();
    this.terminal = null;
    this.task = null;
    // Initialize xterm and fitAddon lazily
    this.xterm = null;
    this.fitAddon = null;
  }

  private async ensureXTermLibraries() {
    if (!FitAddonClass || !TerminalClass) {
      try {
        const [fitAddonModule, xtermModule] = await Promise.all([
          import("@xterm/addon-fit"),
          import("@xterm/xterm"),
        ]);
        FitAddonClass = fitAddonModule.FitAddon;
        TerminalClass = xtermModule.Terminal;
      } catch (error) {
        console.error("Failed to load xterm libraries:", error);
        throw new Error("Failed to load terminal libraries");
      }
    }
  }

  async initTerminal() {
    try {
      await this.ensureXTermLibraries();

      // Initialize xterm and fitAddon
      this.fitAddon = new FitAddonClass!();
      this.xterm = this.createXTerm();
      this.xterm.loadAddon(this.fitAddon);

      let terminal: ProviderTerminal;
      if (this.terminalOverride) {
        terminal = this.terminalOverride;
      } else {
        const result = await this.provider.createTerminal({});
        if (!result.terminal) {
          console.error("Failed to create terminal");
          return;
        }
        terminal = result.terminal;
      }
      this.terminal = terminal;

      // Wire up output: ProviderTerminal → xterm
      terminal.onOutput((data: string) => {
        this.xterm?.write(data);
      });

      // Wire up input: xterm → ProviderTerminal
      this.xterm.onData((data: string) => {
        if (!this.reconnecting) {
          terminal.write(data);
        }
        // Silently drop input during reconnection to avoid data loss
      });

      // Handle terminal resize
      this.xterm.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if ("resize" in terminal && typeof terminal.resize === "function") {
          terminal.resize(cols, rows);
        }
      });

      // Listen for connection state changes if the ProviderTerminal supports it
      this.watchConnectionState(terminal);

      // Listen for reconnection events (server reclaimed grace-period session)
      this.watchReconnectEvents(terminal);

      await terminal.open();

      // Set initial terminal size and environment
      if (
        this.xterm.cols &&
        this.xterm.rows &&
        "resize" in terminal &&
        typeof terminal.resize === "function"
      ) {
        terminal.resize(this.xterm.cols, this.xterm.rows);
      }
    } catch (error) {
      console.error("Failed to initialize terminal:", error);
      this.terminal = null;
    }
  }

  async initTask() {
    try {
      await this.ensureXTermLibraries();

      // Initialize xterm and fitAddon
      this.fitAddon = new FitAddonClass!();
      this.xterm = this.createXTerm();
      this.xterm.loadAddon(this.fitAddon);

      const task = await this.createDevTaskTerminal();
      if (!task) {
        console.error("Failed to create task");
        return;
      }
      this.task = task;
      const output = await task.open();
      this.xterm.write(output);
      this.errorManager.processMessage(output);
      task.onOutput((data: string) => {
        this.xterm?.write(data);
        this.errorManager.processMessage(data);
      });
    } catch (error) {
      console.error("Failed to initialize task:", error);
    }
  }

  createXTerm(): Terminal {
    return new TerminalClass!({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "monospace",
      convertEol: false,
      allowTransparency: true,
      disableStdin: false,
      allowProposedApi: true,
      macOptionIsMeta: true,
      altClickMovesCursor: false,
      windowsMode: false,
      scrollback: 1000,
      screenReaderMode: false,
      fastScrollModifier: "alt",
      fastScrollSensitivity: 5,
    });
  }

  async createDevTaskTerminal() {
    const { task } = await this.provider.getTask({
      args: {
        id: "dev",
      },
    });
    if (!task) {
      console.error("No dev task found");
      return;
    }
    return task;
  }

  /**
   * Watch the ProviderTerminal for connection state changes.
   * If the terminal exposes an `onStateChange` method (added by the new PtyClient),
   * we listen for disconnections and trigger reconnection.
   */
  private watchConnectionState(terminal: ProviderTerminal) {
    this.stateUnsubscribe?.();

    if (
      "onStateChange" in terminal &&
      typeof terminal.onStateChange === "function"
    ) {
      this.stateUnsubscribe = (terminal as any).onStateChange(
        (state: string) => {
          if (state === "disconnected" && !this.reconnecting) {
            this.handleDisconnect();
          } else if (state === "connected" && this.reconnecting) {
            this.handleReconnect();
          }
        },
      );
    }
  }

  /**
   * Watch for PtyClient reconnection events.
   * When the server matches us to an existing grace-period PTY, the
   * PtyClient fires `onReconnect` with the server's (cols, rows).
   * We use this to:
   *  1. Mark the session as reclaimed (not a fresh shell)
   *  2. Clear the "reconnecting" visual state
   *  3. Sync the xterm dimensions
   */
  private watchReconnectEvents(terminal: ProviderTerminal) {
    this.reconnectUnsubscribe?.();

    if (
      "onReconnect" in terminal &&
      typeof terminal.onReconnect === "function"
    ) {
      this.reconnectUnsubscribe = (terminal as any).onReconnect(
        (serverCols: number, serverRows: number) => {
          this.wasReclaimed = true;

          if (this.reconnecting) {
            this.reconnecting = false;
            // Don't show "✓ Reconnected" message for reclaimed sessions —
            // the user shouldn't notice anything happened. The buffered output
            // from the grace period is already being flushed by the server.
            console.log(
              `[terminal-session] Session ${this.id} reclaimed existing PTY`,
            );
          }

          // Sync xterm dimensions with the server's PTY
          if (
            this.terminal &&
            "resize" in this.terminal &&
            typeof this.terminal.resize === "function" &&
            this.xterm
          ) {
            // The server's PTY might have different dimensions than our
            // current xterm. Send our current size to override.
            this.terminal.resize(this.xterm.cols, this.xterm.rows);
          }
        },
      );
    }
  }

  /**
   * Called when the underlying WebSocket disconnects unexpectedly.
   * Shows a visual indicator in the terminal and starts reconnection.
   */
  private handleDisconnect() {
    if (this.reconnecting) return; // Already handling
    this.reconnecting = true;
    this.xterm?.write(RECONNECT_MSG);
    console.warn(`[terminal-session] Connection lost for session ${this.id}`);
  }

  /**
   * Called when the WebSocket reconnects successfully (new PTY spawned).
   * This is for the case where the server could NOT reclaim a grace-period
   * session — a brand new shell was created.
   */
  private handleReconnect() {
    this.reconnecting = false;
    this.wasReclaimed = false;
    this.xterm?.write(RECONNECTED_MSG);
    console.log(`[terminal-session] Reconnected session ${this.id} (new PTY)`);

    // Re-send the current terminal size so the PTY matches
    if (
      this.terminal &&
      this.xterm &&
      "resize" in this.terminal &&
      typeof this.terminal.resize === "function"
    ) {
      this.terminal.resize(this.xterm.cols, this.xterm.rows);
    }
  }

  /**
   * Attempt to reconnect the terminal by creating a new ProviderTerminal.
   * This is used when the PtyClient's auto-reconnect gives up or
   * when the ProviderTerminal doesn't support state change notifications.
   *
   * The old PTY shell process is lost — a new one is created.
   */
  async reconnect(): Promise<boolean> {
    if (this.reconnecting) {
      console.warn("[terminal-session] Already reconnecting");
      return false;
    }

    this.reconnecting = true;
    this.xterm?.write(RECONNECT_MSG);

    try {
      // Kill the old terminal if it's still around
      if (this.terminal) {
        try {
          this.terminal.kill();
        } catch {
          // already dead
        }
        this.terminal = null;
      }

      // Create a new terminal via the provider
      const result = await this.provider.createTerminal({});
      if (!result.terminal) {
        throw new Error("Provider returned no terminal");
      }

      const newTerminal = result.terminal;
      this.terminal = newTerminal;

      // Re-wire output: ProviderTerminal → xterm
      newTerminal.onOutput((data: string) => {
        this.xterm?.write(data);
      });

      // Watch for future disconnections on the new terminal
      this.watchConnectionState(newTerminal);

      // Open the new terminal
      await newTerminal.open();

      // Resize to match current xterm dimensions
      if (
        this.xterm &&
        "resize" in newTerminal &&
        typeof newTerminal.resize === "function"
      ) {
        newTerminal.resize(this.xterm.cols, this.xterm.rows);
      }

      this.reconnecting = false;
      this.xterm?.write(RECONNECTED_MSG);
      console.log(`[terminal-session] Reconnected session ${this.id}`);
      return true;
    } catch (error) {
      this.reconnecting = false;
      this.xterm?.write(RECONNECT_FAILED_MSG);
      console.error(`[terminal-session] Reconnection failed for ${this.id}:`, error);
      return false;
    }
  }

  /** Whether the terminal is currently reconnecting. */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /** Whether the last connection was a reclaimed session (seamless reconnect). */
  wasReclaimedSession(): boolean {
    return this.wasReclaimed;
  }

  dispose() {
    this.stateUnsubscribe?.();
    this.stateUnsubscribe = null;
    this.reconnectUnsubscribe?.();
    this.reconnectUnsubscribe = null;
    this.reconnecting = false;
    this.wasReclaimed = false;

    if (this.xterm) {
      this.xterm.dispose();
    }
    if (this.terminal) {
      try {
        this.terminal.kill();
      } catch (error) {
        console.warn("Failed to kill terminal during disposal:", error);
      }
    }
  }
}
