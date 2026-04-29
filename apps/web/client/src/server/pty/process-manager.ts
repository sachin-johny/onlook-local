import { resolve } from 'node:path';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { getLocalProjectsDir } from '../scaffold';

const activeProcesses = new Map<string, IPty>();

/**
 * Validates that cwd is within the local projects directory, then spawns a PTY.
 */
export function spawnTerminal(
    socketId: string,
    cwd: string,
    cols = 80,
    rows = 24,
): IPty {
    const projectsDir = getLocalProjectsDir();
    const resolvedCwd = resolve(cwd);
    const resolvedProjectsDir = resolve(projectsDir);

    if (!resolvedCwd.startsWith(resolvedProjectsDir)) {
        throw new Error(`cwd "${cwd}" is outside the local projects directory`);
    }

    const shell = process.env.SHELL || '/bin/bash';
    const pty = spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: { ...process.env } as Record<string, string>,
    });

    activeProcesses.set(socketId, pty);
    return pty;
}

/**
 * Kill a specific PTY process by socket ID.
 */
export function killProcess(socketId: string): boolean {
    const pty = activeProcesses.get(socketId);
    if (pty) {
        pty.kill();
        activeProcesses.delete(socketId);
        return true;
    }
    return false;
}

/**
 * Kill all active PTY processes (for graceful shutdown).
 */
export function killAll(): void {
    for (const [id, pty] of activeProcesses) {
        try {
            pty.kill();
        } catch {
            // best-effort
        }
        activeProcesses.delete(id);
    }
}
