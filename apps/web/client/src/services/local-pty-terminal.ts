import { ProviderTerminal } from '@onlook/code-provider';
import { PtyClient } from './pty-client';

/**
 * Local PTY terminal that connects to the WebSocket PTY server.
 * Adapts PtyClient to the ProviderTerminal interface expected by SessionManager.
 */
export class LocalPtyTerminal extends ProviderTerminal {
    private client: PtyClient;
    private outputCallbacks = new Set<(data: string) => void>();
    private connected = false;

    constructor(
        private readonly sandboxId: string,
    ) {
        super();
        this.client = new PtyClient(sandboxId);

        // Bridge PtyClient output to our subscribers immediately.
        // This must be set up before connect() so no output is lost.
        this.client.onOutput((data: string) => {
            for (const cb of this.outputCallbacks) {
                cb(data);
            }
        });
    }

    get id(): string {
        return `${this.sandboxId}-pty`;
    }

    get name(): string {
        return `terminal-${this.sandboxId}`;
    }

    async open(): Promise<string> {
        try {
            await this.client.connect();
            this.connected = true;
            return '';
        } catch (err) {
            const msg = `[pty] Failed to connect: ${err instanceof Error ? err.message : String(err)}`;
            for (const cb of this.outputCallbacks) {
                cb(msg + '\n');
            }
            return msg;
        }
    }

    async write(input: string): Promise<void> {
        if (this.connected) {
            this.client.write(input);
        }
    }

    async run(input: string): Promise<void> {
        if (this.connected) {
            this.client.write(input + '\n');
        }
    }

    async kill(): Promise<void> {
        this.client.kill();
        this.connected = false;
    }

    onOutput(callback: (data: string) => void): () => void {
        this.outputCallbacks.add(callback);
        return () => {
            this.outputCallbacks.delete(callback);
        };
    }

    resize(cols: number, rows: number): void {
        if (this.connected) {
            this.client.resize(cols, rows);
        }
    }
}
