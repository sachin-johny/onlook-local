import type { IPty } from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';
import { PTY_PORT } from './config';
import { killAll, killProcess, spawnTerminal } from './process-manager';

interface PtyMessage {
    type: 'input' | 'resize';
    data?: string;
    cols?: number;
    rows?: number;
}

let wss: WebSocketServer | null = null;

/**
 * Start the PTY WebSocket server. Binds to 127.0.0.1 only.
 */
export function startPtyServer(): void {
    wss = new WebSocketServer({ host: '127.0.0.1', port: PTY_PORT });

    wss.on('connection', (ws: WebSocket, req) => {
        const socketId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

        // Expect cwd as a query parameter: ws://localhost:PORT?cwd=/path/to/project
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const cwd = url.searchParams.get('cwd');

        if (!cwd) {
            ws.close(4001, 'Missing cwd parameter');
            return;
        }

        let pty: IPty;
        try {
            pty = spawnTerminal(socketId, cwd);
        } catch (err) {
            ws.close(4003, err instanceof Error ? err.message : 'Failed to spawn terminal');
            return;
        }

        // Send PTY output to the WebSocket client
        pty.onData((data: string) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data }));
            }
        });

        pty.onExit(({ exitCode }) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
                ws.close();
            }
            killProcess(socketId);
        });

        // Handle incoming messages from the browser
        ws.on('message', (raw: Buffer) => {
            try {
                const msg: PtyMessage = JSON.parse(raw.toString());
                switch (msg.type) {
                    case 'input':
                        pty.write(msg.data ?? '');
                        break;
                    case 'resize':
                        if (msg.cols && msg.rows) {
                            pty.resize(msg.cols, msg.rows);
                        }
                        break;
                }
            } catch {
                // ignore malformed messages
            }
        });

        ws.on('close', () => {
            killProcess(socketId);
        });
    });

    console.log(`[PTY] WebSocket server listening on 127.0.0.1:${PTY_PORT}`);
}

/**
 * Gracefully shut down: kill all PTY processes and close the server.
 */
export function shutdown(): void {
    killAll();
    if (wss) {
        wss.close();
        wss = null;
    }
}
