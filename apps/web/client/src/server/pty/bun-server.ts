import { spawn } from "@zenyr/bun-pty";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";

const PORT = Number(process.env.PTY_PORT ?? 3210);
const PROJECTS_DIR = resolve(
  process.env.PTY_PROJECTS_DIR ?? "./local-projects",
);

/** Custom close codes for better client-side handling */
const CLOSE_CODE = {
  /** Intentional PtyClient.kill() — client will NOT reconnect.
   *  Uses 4000 instead of the WebSocket spec's 1000 to avoid ambiguity:
   *  the browser itself may send 1000 during page reloads, HMR, or
   *  fullscreen transitions — we must not confuse those with an
   *  intentional user-initiated disconnect. */
  CLIENT_DISCONNECT: 4000,
  /** Heartbeat timeout — client SHOULD reconnect */
  HEARTBEAT_TIMEOUT: 4001,
  /** Server shutdown — client SHOULD reconnect after a delay */
  SERVER_SHUTDOWN: 4002,
  /** Client going away (tab close, HMR reload) — client WILL reconnect */
  CLIENT_GOING_AWAY: 1001,
} as const;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * How long to keep a PTY process alive after its WebSocket disconnects.
 * This is the key fix for the "resize kills terminal" bug:
 *
 * When the browser resizes and Next.js HMR triggers a full reload,
 * the WebSocket drops but the client will reconnect within seconds.
 * We keep the PTY alive during this grace period so the reconnected
 * client can resume the same shell session.
 *
 * Set to 0 to disable (immediate kill on disconnect, old behavior).
 */
const SESSION_GRACE_PERIOD_MS = Number(
  process.env.PTY_SESSION_GRACE_PERIOD_MS ?? 15_000,
);

interface PtySession {
  socketId: string;
  cwd: string;
}

interface SessionMeta {
  pty: ReturnType<typeof spawn>;
  /** The sandbox ID this session belongs to — used for reconnection matching */
  sandboxId: string;
  /** Current WebSocket, if connected */
  ws: any | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastPong: number;
  /** Timer for the grace period after WS disconnect */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Whether this session is in its grace period (WS disconnected, PTY still alive) */
  inGracePeriod: boolean;
  /** Terminal dimensions — preserved across reconnections so we can re-fit */
  cols: number;
  rows: number;
  /** Scratch buffer for output that arrived during grace period.
   *  When the client reconnects, we flush this so no data is lost. */
  pendingOutput: string[];
}

const sessions = new Map<string, SessionMeta>();
/**
 * Index: sandboxId → Set of socketIds for that sandbox.
 * Used to find an existing PTY when a client reconnects after HMR.
 */
const sandboxIndex = new Map<string, Set<string>>();

function isPathSafe(cwd: string): boolean {
  const resolved = resolve(cwd);
  return resolved === PROJECTS_DIR || resolved.startsWith(PROJECTS_DIR + "/");
}

// ─── Shell RC setup (unchanged) ───────────────────────────────────────

const SHELL_RC_DIR = mkdtempSync(join(tmpdir(), "onlook-pty-rc-"));
const SHELL_RC_PATH = join(SHELL_RC_DIR, "restrict.sh");

writeFileSync(
  SHELL_RC_PATH,
  /* sh */ `
__onlook_root="$ONLOOK_PROJECT_DIR"
export HOME="$__onlook_root"
unset CDPATH

__onlook_enforce() {
  case "$PWD" in
    "$__onlook_root"|"$__onlook_root"/*) return 0 ;;
  esac

  echo "Cannot navigate outside project directory" >&2
  builtin cd "$__onlook_root" || return 1
  return 1
}

__onlook_cd() {
  if [ "$#" -eq 0 ]; then
    builtin cd "$__onlook_root"
    return $?
  fi

  builtin cd "$@" || return $?
  __onlook_enforce
}

cd() { __onlook_cd "$@"; }
pushd() { echo "pushd disabled" >&2; return 1; }
popd() { echo "popd disabled" >&2; return 1; }

__onlook_chpwd() {
  __onlook_enforce
}

if [ -n "$ZSH_VERSION" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null || true
  add-zsh-hook chpwd __onlook_chpwd 2>/dev/null || true
else
  PROMPT_COMMAND="__onlook_enforce\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
fi

builtin cd "$__onlook_root" || true
`,
  { mode: 0o644 },
);

// ─── Session management helpers ────────────────────────────────────────

function spawnPty(
  socketId: string,
  sandboxId: string,
  cwd: string,
  ws: any,
): SessionMeta {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const shellBase = shell.split("/").pop() ?? "zsh";

  let args: string[] = [];
  let extraEnv: Record<string, string> = {
    ONLOOK_PROJECT_DIR: cwd,
    HOME: cwd,
    CDPATH: "",
  };

  if (shellBase === "bash") {
    const bashRcPath = join(SHELL_RC_DIR, "bashrc");
    writeFileSync(bashRcPath, `source "${SHELL_RC_PATH}"\n`, {
      mode: 0o644,
    });
    args = ["--noprofile", "--rcfile", bashRcPath, "-i"];
  } else if (shellBase === "zsh") {
    const zshRcPath = join(SHELL_RC_DIR, ".zshrc");
    writeFileSync(zshRcPath, `source "${SHELL_RC_PATH}"\n`, {
      mode: 0o644,
    });
    extraEnv.ZDOTDIR = SHELL_RC_DIR;
    args = ["-f", "-i"];
  } else {
    extraEnv.ENV = SHELL_RC_PATH;
  }

  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cwd,
    cols: 80,
    rows: 24,
    env: extraEnv,
  });

  const meta: SessionMeta = {
    pty,
    sandboxId,
    ws,
    heartbeatTimer: null,
    lastPong: Date.now(),
    graceTimer: null,
    inGracePeriod: false,
    cols: 80,
    rows: 24,
    pendingOutput: [],
  };

  // Wire PTY output → WebSocket (or buffer during grace period)
  pty.onData((data) => {
    // NOTE: Use numeric constant 1 (WebSocket.OPEN), not ws.OPEN.
    // Bun's ServerWebSocket doesn't expose OPEN as an instance property.
    if (meta.ws && meta.ws.readyState === 1 /* WebSocket.OPEN */) {
      meta.ws.send(JSON.stringify({ type: "output", data }));
    } else {
      // Client is disconnected — buffer the output so it can be
      // flushed when they reconnect
      meta.pendingOutput.push(data);
      // Prevent unbounded memory growth — cap at ~500KB of buffered output
      const totalLen = meta.pendingOutput.reduce((sum, s) => sum + s.length, 0);
      if (totalLen > 500_000) {
        meta.pendingOutput.shift();
      }
    }
  });

  pty.onExit(({ exitCode }) => {
    if (meta.ws && meta.ws.readyState === 1 /* WebSocket.OPEN */) {
      meta.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      meta.ws.close(CLOSE_CODE.CLIENT_DISCONNECT, "PTY process exited");
    }
    // PTY exited — clean up regardless of grace period
    forceCleanupSession(socketId);
  });

  sessions.set(socketId, meta);

  // Update sandbox index
  let set = sandboxIndex.get(sandboxId);
  if (!set) {
    set = new Set();
    sandboxIndex.set(sandboxId, set);
  }
  set.add(socketId);

  return meta;
}

/** Start a heartbeat for a given session. Sends pings and detects dead connections. */
function startHeartbeat(socketId: string): void {
  stopHeartbeat(socketId);
  const meta = sessions.get(socketId);
  if (!meta || !meta.ws) return;

  const ws = meta.ws;
  meta.lastPong = Date.now();
  meta.heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) {
      stopHeartbeat(socketId);
      return;
    }

    const elapsed = Date.now() - meta.lastPong;
    if (elapsed > HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS) {
      console.warn(`[pty] heartbeat timeout for ${socketId}, closing`);
      ws.close(CLOSE_CODE.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
      return;
    }

    try {
      ws.ping();
    } catch {
      stopHeartbeat(socketId);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/** Stop the heartbeat timer for a given session. */
function stopHeartbeat(socketId: string): void {
  const meta = sessions.get(socketId);
  if (meta?.heartbeatTimer) {
    clearInterval(meta.heartbeatTimer);
    meta.heartbeatTimer = null;
  }
}

/**
 * Start the grace period after a WebSocket disconnect.
 * The PTY stays alive for SESSION_GRACE_PERIOD_MS, during which:
 * - PTY output is buffered in pendingOutput
 * - A new WebSocket with the same sandboxId can reclaim this session
 * - If the grace period expires, the PTY is killed
 */
function startGracePeriod(socketId: string): void {
  const meta = sessions.get(socketId);
  if (!meta) return;

  // Already in grace period — don't restart the timer
  if (meta.inGracePeriod) return;

  if (SESSION_GRACE_PERIOD_MS <= 0) {
    // Grace period disabled — kill immediately (old behavior)
    forceCleanupSession(socketId);
    return;
  }

  meta.inGracePeriod = true;
  meta.ws = null;

  console.log(
    `[pty] session ${socketId} entering grace period (${SESSION_GRACE_PERIOD_MS}ms) for sandbox ${meta.sandboxId}`,
  );

  meta.graceTimer = setTimeout(() => {
    meta.graceTimer = null;
    if (meta.inGracePeriod) {
      console.log(
        `[pty] grace period expired for ${socketId}, killing PTY`,
      );
      forceCleanupSession(socketId);
    }
  }, SESSION_GRACE_PERIOD_MS);
}

/** Cancel the grace period (called when a client reclaims the session). */
function cancelGracePeriod(socketId: string): void {
  const meta = sessions.get(socketId);
  if (!meta) return;

  if (meta.graceTimer) {
    clearTimeout(meta.graceTimer);
    meta.graceTimer = null;
  }
  meta.inGracePeriod = false;
}

/**
 * Try to find an existing PTY session in its grace period for the given sandboxId.
 * Returns the socketId if found, or null.
 *
 * This is the heart of the reconnection fix: when the client reconnects after
 * an HMR reload, we match it to the PTY that lost its WebSocket moments ago,
 * instead of spawning a brand new shell.
 */
function findGracePeriodSession(sandboxId: string): string | null {
  const set = sandboxIndex.get(sandboxId);
  if (!set) return null;

  for (const socketId of set) {
    const meta = sessions.get(socketId);
    if (meta && meta.inGracePeriod) {
      return socketId;
    }
  }
  return null;
}

/** Force-kill a session: kill PTY, stop all timers, remove from maps. */
function forceCleanupSession(socketId: string): void {
  const meta = sessions.get(socketId);
  if (!meta) return;

  // Remove from maps FIRST so that a synchronous pty.onExit callback
  // from pty.kill() won't trigger a second cleanup.
  sessions.delete(socketId);

  const sandboxId = meta.sandboxId;
  const set = sandboxIndex.get(sandboxId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) sandboxIndex.delete(sandboxId);
  }

  stopHeartbeat(socketId);
  cancelGracePeriod(socketId);

  try {
    meta.pty.kill();
  } catch {
    // already dead
  }

  console.log(`[pty] session ${socketId} cleaned up`);
}

// ─── HTTP + WebSocket server ───────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        pid: process.pid,
        sessions: sessions.size,
        gracePeriodSessions: [...sessions.values()].filter(
          (m) => m.inGracePeriod,
        ).length,
      });
    }

    // New endpoint: list sessions in grace period for a sandbox
    if (url.pathname === "/sessions") {
      const sandboxId = url.searchParams.get("sandboxId");
      if (!sandboxId) {
        return new Response("Missing sandboxId parameter", { status: 400 });
      }
      const set = sandboxIndex.get(sandboxId);
      const result: Array<{
        socketId: string;
        inGracePeriod: boolean;
        cols: number;
        rows: number;
      }> = [];
      if (set) {
        for (const socketId of set) {
          const meta = sessions.get(socketId);
          if (meta) {
            result.push({
              socketId,
              inGracePeriod: meta.inGracePeriod,
              cols: meta.cols,
              rows: meta.rows,
            });
          }
        }
      }
      return Response.json(result);
    }

    // Client sends sandboxId — resolve to absolute cwd within projects dir
    const sandboxId = url.searchParams.get("sandboxId");
    if (!sandboxId) {
      return new Response("Missing sandboxId parameter", { status: 400 });
    }

    const cwd = join(PROJECTS_DIR, sandboxId);
    if (!isPathSafe(cwd)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return new Response("Sandbox directory not found", { status: 404 });
    }

    const socketId = `${new Date().getTime()}-${Math.random().toString(36).slice(2, 9)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upgraded = (server.upgrade as any)(req, {
      data: { socketId, cwd, sandboxId },
    });
    return upgraded
      ? undefined
      : new Response("Upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) {
      const { cwd, socketId, sandboxId } = ws.data as unknown as PtySession & {
        sandboxId: string;
      };

      // ──── Reconnection: try to reclaim an existing PTY in grace period ────
      const existingSocketId = findGracePeriodSession(sandboxId);
      if (existingSocketId) {
        const meta = sessions.get(existingSocketId)!;
        console.log(
          `[pty] reclaiming grace-period session ${existingSocketId} for sandbox ${sandboxId}`,
        );

        // Cancel grace period and reattach this WebSocket
        cancelGracePeriod(existingSocketId);
        meta.ws = ws;
        meta.inGracePeriod = false;

        // Flush buffered output that arrived during the grace period
        if (meta.pendingOutput.length > 0) {
          const buffered = meta.pendingOutput.join("");
          meta.pendingOutput = [];
          ws.send(JSON.stringify({ type: "output", data: buffered }));
          console.log(
            `[pty] flushed ${buffered.length} bytes of buffered output to reconnected client`,
          );
        }

        // Re-apply terminal dimensions
        ws.send(
          JSON.stringify({
            type: "reconnected",
            socketId: existingSocketId,
            cols: meta.cols,
            rows: meta.rows,
          }),
        );

        // Start heartbeat on the new WebSocket
        startHeartbeat(existingSocketId);

        // Update ws.data so message/close handlers use the right socketId
        (ws.data as any).socketId = existingSocketId;
        return;
      }

      // ──── New session: spawn a fresh PTY ────
      const meta = spawnPty(socketId, sandboxId, cwd, ws);
      startHeartbeat(socketId);
      console.log(
        `[pty] session ${socketId} opened (sandbox=${sandboxId}, cwd=${cwd})`,
      );
    },

    message(ws, msg) {
      const { socketId } = ws.data as unknown as PtySession;
      const meta = sessions.get(socketId);
      if (!meta) return;

      // Update heartbeat on any client message (acts as a pong)
      meta.lastPong = Date.now();

      const { type, data, cols, rows } = JSON.parse(msg as string);

      if (type === "input") {
        meta.pty.write(data);
      }
      if (type === "resize") {
        meta.cols = cols;
        meta.rows = rows;
        meta.pty.resize(cols, rows);
      }
      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    },

    close(ws, code, _reason) {
      const { socketId } = ws.data as unknown as PtySession;
      const meta = sessions.get(socketId);
      console.log(
        `[pty] session ${socketId} WebSocket closed (code=${code})`,
      );

      if (!meta) return;

      stopHeartbeat(socketId);

      // Intentional disconnect — kill the PTY immediately
      if (code === CLOSE_CODE.CLIENT_DISCONNECT) {
        console.log(`[pty] intentional disconnect for ${socketId}`);
        forceCleanupSession(socketId);
        return;
      }

      // PTY process already exited — just clean up
      if (!meta.pty) {
        forceCleanupSession(socketId);
        return;
      }

      // ──── Grace period: keep the PTY alive for reconnection ────
      // This handles HMR reloads, tab refreshes, browser resize triggers, etc.
      // The client will reconnect and reclaim this session via findGracePeriodSession().
      startGracePeriod(socketId);
    },

    // Handle pong responses from ws.ping()
    pong(ws) {
      const { socketId } = ws.data as unknown as PtySession;
      const meta = sessions.get(socketId);
      if (meta) meta.lastPong = Date.now();
    },
  },
});

function shutdown() {
  for (const [socketId, meta] of sessions.entries()) {
    stopHeartbeat(socketId);
    cancelGracePeriod(socketId);
    try {
      meta.pty.kill();
    } catch {
      // already dead
    }
  }
  sessions.clear();
  sandboxIndex.clear();
  server.stop();
  rmSync(SHELL_RC_DIR, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(
  `[pty] server ready on 127.0.0.1:${PORT} (grace period: ${SESSION_GRACE_PERIOD_MS}ms)`,
);
