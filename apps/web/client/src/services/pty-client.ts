/** Must match the default in server/pty/config.ts */
const PTY_PORT = 3210;

export enum ConnectionState {
    DISCONNECTED = "disconnected",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    RECONNECTING = "reconnecting",
}

interface PtyClientOptions {
    /** Maximum number of reconnection attempts (default: 10) */
    maxReconnectAttempts?: number;
    /** Initial delay in ms before first reconnect (default: 500) */
    initialReconnectDelay?: number;
    /** Maximum delay in ms between reconnection attempts (default: 30000) */
    maxReconnectDelay?: number;
    /** Heartbeat interval in ms — sends a ping to keep the connection alive (default: 30000) */
    heartbeatInterval?: number;
}

type StateChangeCallback = (state: ConnectionState) => void;
type ReconnectCallback = (cols: number, rows: number) => void;

export class PtyClient {
    private ws: WebSocket | null = null;
    private outputCallbacks = new Set<(data: string) => void>();
    private stateChangeCallbacks = new Set<StateChangeCallback>();
    private reconnectCallbacks = new Set<ReconnectCallback>();
    private state: ConnectionState = ConnectionState.DISCONNECTED;

    // Reconnection state
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose = false;
    private connectPromiseReject: ((reason: Error) => void) | null = null;

    // Heartbeat state
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private missedHeartbeats = 0;
    private readonly MAX_MISSED_HEARTBEATS = 3;

    // Current terminal dimensions — sent on reconnect so the PTY matches
    private currentCols: number = 80;
    private currentRows: number = 24;

    // Whether this client reclaimed a grace-period session on the server
    private isReclaimedSession = false;

    // Configuration
    private readonly maxReconnectAttempts: number;
    private readonly initialReconnectDelay: number;
    private readonly maxReconnectDelay: number;
    private readonly heartbeatIntervalMs: number;

    constructor(
        private readonly sandboxId: string,
        options?: PtyClientOptions,
    ) {
        this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 10;
        this.initialReconnectDelay = options?.initialReconnectDelay ?? 500;
        this.maxReconnectDelay = options?.maxReconnectDelay ?? 30000;
        this.heartbeatIntervalMs = options?.heartbeatInterval ?? 30000;
    }

    /** Current connection state */
    getState(): ConnectionState {
        return this.state;
    }

    /** Whether this client reclaimed an existing session (not a fresh PTY) */
    getIsReclaimedSession(): boolean {
        return this.isReclaimedSession;
    }

    /** Register a listener for connection state changes. Returns an unsubscribe function. */
    onStateChange(callback: StateChangeCallback): () => void {
        this.stateChangeCallbacks.add(callback);
        return () => {
            this.stateChangeCallbacks.delete(callback);
        };
    }

    /**
     * Register a callback for when the server sends a `reconnected` message,
     * meaning the client successfully reclaimed an existing PTY session.
     * The callback receives the server's (cols, rows) so the client can
     * resize to match.
     */
    onReconnect(callback: ReconnectCallback): () => void {
        this.reconnectCallbacks.add(callback);
        return () => {
            this.reconnectCallbacks.delete(callback);
        };
    }

    /** Register an output handler. Safe to call before connect(). */
    onOutput(callback: (data: string) => void): () => void {
        this.outputCallbacks.add(callback);
        return () => {
            this.outputCallbacks.delete(callback);
        };
    }

    /** Connect to the PTY WebSocket server. Resolves when connected. */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.intentionalClose = false;
            this.isReclaimedSession = false;
            this.setState(ConnectionState.CONNECTING);
            this.connectPromiseReject = reject;

            const url = `ws://127.0.0.1:${PTY_PORT}?sandboxId=${encodeURIComponent(this.sandboxId)}`;

            try {
                this.ws = new WebSocket(url);
            } catch (err) {
                const error = new Error(
                    `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
                );
                this.setState(ConnectionState.DISCONNECTED);
                reject(error);
                return;
            }

            this.ws.onopen = () => {
                console.log("[pty-client] connected to", url);
                this.reconnectAttempts = 0;
                this.missedHeartbeats = 0;
                this.connectPromiseReject = null;
                this.startHeartbeat();
                this.setState(ConnectionState.CONNECTED);
                resolve();
            };

            this.ws.onmessage = (event) => {
                this.missedHeartbeats = 0;

                try {
                    const msg = JSON.parse(event.data as string);

                    if (msg.type === "output" && typeof msg.data === "string") {
                        for (const cb of this.outputCallbacks) {
                            cb(msg.data);
                        }
                    } else if (msg.type === "reconnected") {
                        // Server matched us to an existing grace-period PTY session!
                        // This means our terminal output from before the disconnect
                        // is still there. The server also sends buffered output.
                        this.isReclaimedSession = true;
                        console.log(
                            "[pty-client] reclaimed existing session",
                            msg.socketId,
                            `cols=${msg.cols} rows=${msg.rows}`,
                        );
                        // Notify listeners so they can resize xterm to match
                        for (const cb of this.reconnectCallbacks) {
                            cb(msg.cols ?? 80, msg.rows ?? 24);
                        }
                        // Re-send our current terminal dimensions to sync with server
                        this.resize(this.currentCols, this.currentRows);
                    } else if (msg.type === "exit") {
                        // PTY process exited — this is a clean shutdown, don't reconnect
                        console.log(
                            "[pty-client] PTY process exited with code",
                            msg.code,
                        );
                        this.intentionalClose = true;
                    } else if (msg.type === "pong") {
                        // Heartbeat pong — missedHeartbeats already reset above
                    }
                } catch {
                    // ignore malformed messages
                }
            };

            this.ws.onerror = (event) => {
                // WebSocket ErrorEvent often has an empty message — the real info
                // is in the onclose handler that fires immediately after.
                // The "pty server not found" error manifests here when the server
                // isn't running — onclose will follow with code 1006.
                console.warn("[pty-client] WebSocket error (close will follow)", {
                    type: (event as ErrorEvent).type,
                    message: (event as ErrorEvent).message || "(no message)",
                });

                // If we're still in the initial connect() call, reject the promise.
                // But DON'T set intentionalClose — we want scheduleReconnect() to retry.
                if (this.connectPromiseReject) {
                    this.connectPromiseReject(
                        new Error("PTY WebSocket connection failed — is the PTY server running?"),
                    );
                    this.connectPromiseReject = null;
                }
            };

            this.ws.onclose = (event) => {
                console.log(
                    "[pty-client] closed",
                    event.code,
                    event.reason,
                    "intentional:",
                    this.intentionalClose,
                );
                this.stopHeartbeat();
                this.ws = null;

                if (this.intentionalClose) {
                    // Explicit kill() or PTY exit — stay disconnected
                    this.setState(ConnectionState.DISCONNECTED);
                    return;
                }

                // Unexpected close — attempt reconnection
                // This handles:
                //   - code 1006: server not running (the "pty server not found" case)
                //   - code 1001: browser tab going away (HMR reload)
                //   - code 4001: heartbeat timeout
                this.scheduleReconnect();
            };
        });
    }

    /** Send input data to the PTY. Silently drops if not connected. */
    write(data: string): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "input", data }));
        }
    }

    /** Resize the PTY. Silently drops if not connected. */
    resize(cols: number, rows: number): void {
        // Always track the current dimensions, even if disconnected.
        // When we reconnect, we'll send these to sync the PTY.
        this.currentCols = cols;
        this.currentRows = rows;

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
    }

    /** Kill the connection. No reconnection will be attempted. */
    kill(): void {
        this.intentionalClose = true;
        this.cancelReconnect();
        this.stopHeartbeat();

        if (this.ws) {
            // Use a custom close code (4000) so the server can distinguish
            // intentional PtyClient.kill() from browser-sent code 1000
            // (which can fire during page reloads, HMR, or fullscreen transitions).
            this.ws.close(4000, "Client disconnect");
            this.ws = null;
        }

        this.outputCallbacks.clear();
        this.stateChangeCallbacks.clear();
        this.reconnectCallbacks.clear();
        this.setState(ConnectionState.DISCONNECTED);
    }

    // ─── Private helpers ─────────────────────────────────────────────────

    private setState(newState: ConnectionState): void {
        if (this.state === newState) return;
        this.state = newState;
        for (const cb of this.stateChangeCallbacks) {
            try {
                cb(newState);
            } catch {
                // don't let a subscriber break the state machine
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.intentionalClose) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(
                `[pty-client] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`,
            );
            this.setState(ConnectionState.DISCONNECTED);
            return;
        }

        this.setState(ConnectionState.RECONNECTING);

        // Exponential backoff with jitter.
        // First attempt after 500ms (fast for HMR reloads), then 1s, 2s, 4s...
        const baseDelay = Math.min(
            this.initialReconnectDelay *
                Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay,
        );
        const jitter = baseDelay * 0.2 * Math.random();
        const delay = baseDelay + jitter;

        this.reconnectAttempts++;

        console.log(
            `[pty-client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        );

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                console.log("[pty-client] Reconnected successfully");
            } catch (err) {
                // connect() itself will schedule the next attempt via onclose → scheduleReconnect()
                console.warn(
                    "[pty-client] Reconnect attempt failed:",
                    err instanceof Error ? err.message : String(err),
                );
            }
        }, delay);
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.missedHeartbeats = 0;

        this.heartbeatTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.stopHeartbeat();
                return;
            }

            this.missedHeartbeats++;
            if (this.missedHeartbeats > this.MAX_MISSED_HEARTBEATS) {
                console.warn(
                    "[pty-client] No heartbeat response after",
                    this.MAX_MISSED_HEARTBEATS,
                    "pings — closing connection",
                );
                this.ws.close(4001, "Heartbeat timeout");
                return;
            }

            try {
                this.ws.send(JSON.stringify({ type: "ping" }));
            } catch {
                this.stopHeartbeat();
            }
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.missedHeartbeats = 0;
    }
}
