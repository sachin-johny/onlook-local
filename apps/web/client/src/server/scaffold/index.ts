import { exec } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NEXTJS_TEMPLATE } from './template';

/**
 * Returns the root directory for all local-mode projects.
 * Reads ONLOOK_LOCAL_PROJECTS_DIR env var, defaults to ./local-projects.
 */
export function getLocalProjectsDir(): string {
    return process.env.ONLOOK_LOCAL_PROJECTS_DIR?.trim() || './local-projects';
}

/**
 * Scaffolds a new Next.js + Tailwind project on disk.
 * Creates directories and writes all template files, then runs `bun install`.
 */
export async function scaffoldProject(
    projectDir: string,
    projectName: string,
): Promise<void> {
    await mkdir(projectDir, { recursive: true });

    const entries = Object.entries(NEXTJS_TEMPLATE);
    await Promise.all(
        entries.map(async ([relativePath, content]) => {
            const filePath = join(projectDir, relativePath);
            const dir = join(filePath, '..');
            await mkdir(dir, { recursive: true });
            const finalContent = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
            await writeFile(filePath, finalContent, 'utf-8');
        }),
    );

    // Run bun install asynchronously
    await new Promise<void>((resolve, reject) => {
        exec('bun install', { cwd: projectDir, timeout: 60_000 }, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

/**
 * Removes a project directory on failure (rollback).
 */
export async function cleanupProject(projectDir: string): Promise<void> {
    await rm(projectDir, { recursive: true, force: true });
}
