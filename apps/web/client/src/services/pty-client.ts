/** Must match the default in server/pty/config.ts */
const PTY_PORT = 3210;

export class PtyClient {
    private ws: WebSocket | null = null;
    private outputCallbacks = new Set<(data: string) => void>();

    constructor(private readonly sandboxId: string) {}

    /** Register an output handler. Safe to call before connect(). */
    onOutput(callback: (data: string) => void): () => void {
        this.outputCallbacks.add(callback);
        return () => {
            this.outputCallbacks.delete(callback);
        };
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `ws://127.0.0.1:${PTY_PORT}?sandboxId=${encodeURIComponent(this.sandboxId)}`;
            try {
                this.ws = new WebSocket(url);
            } catch (err) {
                reject(new Error(`Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }

            this.ws.onopen = () => {
                console.log('[pty-client] connected to', url);
                resolve();
            };

            this.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data as string);
                    if (msg.type === 'output' && typeof msg.data === 'string') {
                        for (const cb of this.outputCallbacks) {
                            cb(msg.data);
                        }
                    }
                } catch {
                    // ignore malformed messages
                }
            };

            this.ws.onerror = (event) => {
                console.error('[pty-client] WebSocket error', event);
                reject(new Error(`PTY WebSocket error`));
            };

            this.ws.onclose = (event) => {
                console.log('[pty-client] closed', event.code, event.reason);
                this.ws = null;
            };
        });
    }

    write(data: string): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'input', data }));
        }
    }

    resize(cols: number, rows: number): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    }

    kill(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.outputCallbacks.clear();
    }
}
