/** Must match the default in server/pty/config.ts */
const PTY_PORT = 3210;

export class PtyClient {
    private ws: WebSocket | null = null;
    private outputCallbacks = new Set<(data: string) => void>();

    constructor(private readonly sandboxId: string) {}

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `ws://127.0.0.1:${PTY_PORT}?sandboxId=${encodeURIComponent(this.sandboxId)}`;
            this.ws = new WebSocket(url);

            this.ws.onopen = () => resolve();

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
                reject(new Error(`PTY WebSocket error: ${event.type}`));
            };

            this.ws.onclose = () => {
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

    onOutput(callback: (data: string) => void): () => void {
        this.outputCallbacks.add(callback);
        return () => {
            this.outputCallbacks.delete(callback);
        };
    }

    kill(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.outputCallbacks.clear();
    }
}
