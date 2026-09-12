import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Dev-server process manager for local-mode sandboxes. Spawns the imported
 * project's `dev` script (detected via its lockfile) inside the bound folder and
 * keeps a capped log ring per server. Processes are keyed by the resolved root —
 * the same folder is always the same server, no matter which sandbox id reaches it.
 *
 * Pure process management: callers resolve the sandbox to a root first (see
 * `startSandboxDevServer` in `local-fs.ts`). The Next.js server hosts these child
 * processes; they die with it.
 */

export interface DevServerStatus {
    running: boolean;
    port: number | null;
    pid: number | null;
    command: string | null;
    startedAt: number | null;
    exitCode: number | null;
    logs: string[];
}

interface DevServerProcess {
    root: string;
    port: number;
    command: string;
    proc: ChildProcess;
    startedAt: number;
    exitCode: number | null;
    logs: string[];
}

const MAX_LOG_LINES = 400;
const MAX_LOG_LINE_LENGTH = 500;
const EXIT_WAIT_MS = 8000;

const servers = new Map<string, DevServerProcess>();

const normalizeRootKey = (root: string) =>
    process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);

/** Pick the package manager from the project's lockfile; npm is the fallback. */
function detectDevCommand(root: string): string {
    const has = (name: string) => fs.existsSync(path.join(root, name));
    if (has('bun.lockb') || has('bun.lock')) {
        return 'bun run dev';
    }
    if (has('pnpm-lock.yaml')) {
        return 'pnpm run dev';
    }
    if (has('yarn.lock')) {
        return 'yarn dev';
    }
    return 'npm run dev';
}

export function resolveDevServerPort(fallback?: number): number {
    if (fallback && Number.isFinite(fallback)) {
        return Math.trunc(fallback);
    }
    const fromEnv = Number(new URL(process.env.NEXT_PUBLIC_LOCAL_PREVIEW_URL?.trim() || 'http://localhost:8084').port);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 8084;
}

function pushLog(server: DevServerProcess, chunk: string) {
    const lines = chunk.split(/\r?\n/).filter((line) => line.length > 0);
    for (const line of lines) {
        server.logs.push(line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…` : line);
    }
    if (server.logs.length > MAX_LOG_LINES) {
        server.logs.splice(0, server.logs.length - MAX_LOG_LINES);
    }
}

function toStatus(server: DevServerProcess | undefined): DevServerStatus {
    if (!server) {
        return {
            running: false,
            port: null,
            pid: null,
            command: null,
            startedAt: null,
            exitCode: null,
            logs: [],
        };
    }
    return {
        running: server.exitCode === null,
        port: server.port,
        pid: server.proc.pid ?? null,
        command: server.command,
        startedAt: server.startedAt,
        exitCode: server.exitCode,
        logs: server.logs,
    };
}

export async function startDevServerAt(root: string, port?: number): Promise<DevServerStatus> {
    const key = normalizeRootKey(root);
    const existing = servers.get(key);
    if (existing && existing.exitCode === null) {
        return toStatus(existing);
    }

    const resolvedPort = resolveDevServerPort(port);
    const command = detectDevCommand(root);

    // Strip this app's own bundler flags: Onlook runs under `next dev --turbo`,
    // which exports TURBOPACK=1 — inheriting it would make a project script like
    // `next dev --webpack` abort with "Multiple bundler flags set".
    const inheritedEnv = { ...process.env };
    delete inheritedEnv.TURBOPACK;
    delete inheritedEnv.WEBPACK;

    const proc = spawn(command, {
        shell: true,
        cwd: root,
        env: { ...inheritedEnv, PORT: String(resolvedPort), BROWSER: 'none' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const server: DevServerProcess = {
        root,
        port: resolvedPort,
        command,
        proc,
        startedAt: Date.now(),
        exitCode: null,
        logs: [],
    };
    servers.set(key, server);

    proc.stdout?.on('data', (data: Buffer) => pushLog(server, data.toString()));
    proc.stderr?.on('data', (data: Buffer) => pushLog(server, data.toString()));
    proc.on('error', (error) => {
        pushLog(server, `[onlook] Failed to launch dev server: ${error.message}`);
        server.exitCode = -1;
    });
    proc.on('exit', (code) => {
        server.exitCode = code ?? -1;
        pushLog(server, `[onlook] Dev server exited with code ${server.exitCode}`);
    });

    pushLog(server, `[onlook] Starting dev server: ${command} (port ${resolvedPort}) in ${root}`);
    return toStatus(server);
}

export async function stopDevServerAt(root: string): Promise<DevServerStatus> {
    const key = normalizeRootKey(root);
    const server = servers.get(key);
    if (!server || server.exitCode !== null) {
        return toStatus(server);
    }

    const { proc } = server;
    if (process.platform === 'win32') {
        // shell:true wraps the command in cmd.exe — kill the whole tree.
        if (proc.pid) {
            spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        }
    } else {
        proc.kill('SIGTERM');
    }

    const exited = new Promise<void>((resolve) => {
        if (server.exitCode !== null) {
            resolve();
            return;
        }
        proc.once('exit', () => resolve());
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, EXIT_WAIT_MS));
    await Promise.race([exited, timeout]);
    if (server.exitCode === null && process.platform !== 'win32') {
        proc.kill('SIGKILL');
    }

    return toStatus(server);
}

export function devServerStatusAt(root: string): DevServerStatus {
    return toStatus(servers.get(normalizeRootKey(root)));
}
