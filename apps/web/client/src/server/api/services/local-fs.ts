import { TRPCError } from '@trpc/server';
import { getDb } from '@onlook/db/src/sqlite-client';
import { localSandboxes } from '@onlook/db/src/sqlite-schema';
import type {
    NodeFsReadManyOutput,
    NodeFsReadResult,
    NodeFsTransport,
    NodeFsTransportEntry,
    NodeFsWriteInput,
} from '@onlook/code-provider';
import { BINARY_EXTENSIONS, IGNORED_UPLOAD_DIRECTORIES } from '@onlook/constants';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Server-side disk I/O for local-mode sandboxes. Every sandbox id may be mapped to a
 * real folder on disk via the `local_sandboxes` table; all entry operations resolve the
 * sandbox root through that mapping and guard against path traversal before touching
 * the filesystem.
 */

const PRUNED_TREE_DIRECTORIES = new Set([
    ...IGNORED_UPLOAD_DIRECTORIES,
    '.turbo',
    '.onlook',
    'coverage',
    'static',
    'out',
]);

const READ_MANY_MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const READ_MANY_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface LocalPathValidation {
    valid: boolean;
    resolvedPath?: string;
    name?: string;
    routerType?: 'app' | 'pages';
    devPort?: number;
    error?: string;
}

// Sandbox id -> absolute root. Local mode only; a handful of sandboxes per session.
const rootCache = new Map<string, string>();

const toPosix = (value: string) => value.replaceAll('\\', '/');

const samePath = (a: string, b: string) => {
    const left = process.platform === 'win32' ? a.toLowerCase() : a;
    const right = process.platform === 'win32' ? b.toLowerCase() : b;
    return left === right;
};

const isBinaryPath = (entryPath: string) => {
    const extension = path.extname(entryPath).toLowerCase();
    return BINARY_EXTENSIONS.includes(extension);
};

const getRootWithSep = (root: string) => (root.endsWith(path.sep) ? root : root + path.sep);

const isInsideRoot = (root: string, target: string) => {
    const rootWithSep = getRootWithSep(root);
    return samePath(target, root) || target.toLowerCase().startsWith(rootWithSep.toLowerCase());
};

/**
 * Resolve a sandbox-relative path to an absolute path, refusing traversal outside the
 * sandbox root. `allowRoot` marks operations where addressing the root itself is legal
 * (e.g. listing the project root); mutations always refuse it.
 */
function resolveEntryPath(root: string, entryPath: string, allowRoot: boolean): string {
    const segments = toPosix(entryPath.trim())
        .split('/')
        .filter((segment) => segment.length > 0 && segment !== '.');

    if (segments.length === 0) {
        if (allowRoot) {
            return root;
        }
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Refusing to operate on the project root. Re-import with a specific folder.',
        });
    }

    if (segments.some((segment) => segment === '..')) {
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid path: ${entryPath}`,
        });
    }

    const target = path.resolve(root, ...segments);
    if (!isInsideRoot(root, target)) {
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Path escapes the project folder: ${entryPath}`,
        });
    }

    return target;
}

function toRelativeEntry(root: string, target: string): string {
    const relative = path.relative(root, target).replaceAll('\\', '/');
    return relative;
}

function mapFsError(error: unknown, entryPath: string): TRPCError {
    if (error instanceof TRPCError) {
        return error;
    }
    const code = (error as { code?: string })?.code;
    if (code === 'ENOENT') {
        return new TRPCError({
            code: 'NOT_FOUND',
            message: `Path not found: ${entryPath}`,
            cause: error,
        });
    }
    if (code === 'EEXIST') {
        return new TRPCError({
            code: 'CONFLICT',
            message: `Path already exists: ${entryPath}`,
            cause: error,
        });
    }
    if (code === 'ENOTEMPTY' || code === 'EPERM') {
        return new TRPCError({
            code: 'CONFLICT',
            message: `Operation not permitted on: ${entryPath}`,
            cause: error,
        });
    }
    return new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : `File operation failed: ${entryPath}`,
        cause: error,
    });
}

// ─── Sandbox root mapping ────────────────────────────────────────────

export async function resolveLocalRoot(sandboxId: string): Promise<string | null> {
    const cached = rootCache.get(sandboxId);
    if (cached) {
        return cached;
    }

    try {
        const row = await getDb()
            .select({ localPath: localSandboxes.localPath })
            .from(localSandboxes)
            .where(eq(localSandboxes.sandboxId, sandboxId))
            .limit(1);

        const localPath = row[0]?.localPath;
        if (!localPath) {
            return null;
        }

        rootCache.set(sandboxId, localPath);
        return localPath;
    } catch (error) {
        console.warn(`[local-fs] Failed to resolve local root for ${sandboxId}:`, error);
        return null;
    }
}

export async function bindLocalSandbox(
    sandboxId: string,
    localPath: string,
    displayName?: string,
): Promise<void> {
    const resolved = resolveInputRoot(localPath);
    const root = fs.realpathSync(resolved);

    const db = getDb();
    await db
        .insert(localSandboxes)
        .values({
            sandboxId,
            localPath: root,
            displayName: displayName ?? null,
        })
        .onConflictDoUpdate({
            target: localSandboxes.sandboxId,
            set: {
                localPath: root,
                displayName: displayName ?? null,
                updatedAt: new Date(),
            },
        });

    rootCache.set(sandboxId, root);
}

export async function unbindLocalSandbox(sandboxId: string): Promise<void> {
    rootCache.delete(sandboxId);
    await getDb().delete(localSandboxes).where(eq(localSandboxes.sandboxId, sandboxId));
}

function resolveInputRoot(localPath: string): string {
    const trimmed = localPath.trim();
    if (!trimmed) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Local path is required' });
    }

    if (!path.isAbsolute(trimmed)) {
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Local path must be absolute: ${trimmed}`,
        });
    }

    const resolved = path.resolve(trimmed);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Folder does not exist: ${resolved}`,
        });
    }

    if (!stat.isDirectory()) {
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Path is not a folder: ${resolved}`,
        });
    }

    return resolved;
}

// ─── Path validation (import wizard) ─────────────────────────────────

const DEV_PORT_REGEX = /(?:PORT=|--port[=\s]|-p\s*?)(\d+)/;
const LAYOUT_FILE_NAMES = ['.js', '.jsx', '.ts', '.tsx'].map((ext) => `layout${ext}`);

export async function validateLocalPath(localPath: string): Promise<LocalPathValidation> {
    let root: string;
    try {
        root = resolveInputRoot(localPath);
    } catch (error) {
        return {
            valid: false,
            error: error instanceof TRPCError ? error.message : 'Invalid folder path',
        };
    }

    const resolvedPath = (() => {
        try {
            return fs.realpathSync(root);
        } catch {
            return root;
        }
    })();

    const packageJsonPath = path.join(resolvedPath, 'package.json');
    let packageJson: Record<string, unknown>;
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
        return {
            valid: false,
            resolvedPath,
            error: 'No readable package.json found in this folder',
        };
    }

    const dependencies = packageJson.dependencies as Record<string, string> | undefined;
    const devDependencies = packageJson.devDependencies as Record<string, string> | undefined;
    if (!dependencies?.next && !devDependencies?.next) {
        return {
            valid: false,
            resolvedPath,
            name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
            error: 'Next.js was not found in package.json dependencies',
        };
    }

    const detectRouter = (): 'app' | 'pages' | undefined => {
        const appDirs = ['app', 'src/app'];
        for (const appDir of appDirs) {
            const dir = path.join(resolvedPath, ...appDir.split('/'));
            if (!fs.existsSync(dir)) {
                continue;
            }
            const hasLayout = fs
                .readdirSync(dir)
                .some((entry) => LAYOUT_FILE_NAMES.includes(entry));
            if (hasLayout) {
                return 'app';
            }
        }

        const hasPagesDir = ['pages', 'src/pages'].some((pagesDir) =>
            fs.existsSync(path.join(resolvedPath, ...pagesDir.split('/'))),
        );
        return hasPagesDir ? 'pages' : undefined;
    };

    const routerType = detectRouter();
    if (!routerType) {
        return {
            valid: false,
            resolvedPath,
            name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
            error: 'No app/ or pages/ directory found — is this a Next.js project?',
        };
    }

    let devPort: number | undefined;
    const scripts = packageJson.scripts as Record<string, string> | undefined;
    const portMatch = scripts?.dev ? DEV_PORT_REGEX.exec(scripts.dev) : null;
    if (portMatch?.[1]) {
        const port = Number.parseInt(portMatch[1], 10);
        if (port > 0 && port <= 65535) {
            devPort = port;
        }
    }

    return {
        valid: true,
        resolvedPath,
        name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
        routerType,
        devPort,
    };
}

// ─── File operations ─────────────────────────────────────────────────

async function requireRoot(sandboxId: string): Promise<string> {
    const root = await resolveLocalRoot(sandboxId);
    if (!root) {
        throw new TRPCError({
            code: 'NOT_FOUND',
            message:
                'This sandbox is not linked to a local folder — delete the project and re-import it.',
        });
    }
    return root;
}

function statEntrySync(root: string, entryPath: string, allowRoot: boolean): NodeFsTransportEntry {
    try {
        const target = resolveEntryPath(root, entryPath, allowRoot);
        const stat = fs.statSync(target);
        return {
            path: toRelativeEntry(root, target),
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.isFile() ? stat.size : undefined,
        };
    } catch (error) {
        throw mapFsError(error, entryPath);
    }
}

export async function statEntry(sandboxId: string, entryPath: string): Promise<NodeFsTransportEntry> {
    const root = await requireRoot(sandboxId);
    return statEntrySync(root, entryPath, true);
}

export async function listDir(sandboxId: string, dirPath: string): Promise<NodeFsTransportEntry[]> {
    const root = await requireRoot(sandboxId);
    const target = resolveEntryPath(root, dirPath, true);

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
        throw mapFsError(error, dirPath);
    }

    return entries
        .map((entry) => {
            const relative = toRelativeEntry(root, path.join(target, entry.name));
            return {
                path: relative,
                type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
                size: entry.isFile()
                    ? (() => {
                        try {
                            return fs.statSync(path.join(target, entry.name)).size;
                        } catch {
                            return undefined;
                        }
                    })()
                    : undefined,
            };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}

export async function listTree(sandboxId: string): Promise<NodeFsTransportEntry[]> {
    const root = await requireRoot(sandboxId);

    try {
        if (!fs.statSync(root).isDirectory()) {
            throw new Error('not a directory');
        }
    } catch (error) {
        throw mapFsError(error, root);
    }

    const entries: NodeFsTransportEntry[] = [];

    const walk = (current: string) => {
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }

        for (const dirent of dirents) {
            const target = path.join(current, dirent.name);
            const relative = toRelativeEntry(root, target);
            if (dirent.isDirectory()) {
                const segments = relative.split('/');
                if (segments.some((segment) => PRUNED_TREE_DIRECTORIES.has(segment))) {
                    continue;
                }
                entries.push({ path: relative, type: 'directory' });
                walk(target);
                continue;
            }
            if (dirent.isFile()) {
                try {
                    entries.push({
                        path: relative,
                        type: 'file',
                        size: fs.statSync(target).size,
                    });
                } catch {
                    // File vanished mid-walk; skip it.
                }
            }
        }
    };

    walk(root);
    return entries;
}

function readEntrySync(root: string, entryPath: string): NodeFsReadResult {
    try {
        const target = resolveEntryPath(root, entryPath, false);
        const stat = fs.statSync(target);
        if (!stat.isFile()) {
            throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Path is a directory, not a file: ${entryPath}`,
            });
        }

        if (isBinaryPath(entryPath)) {
            return {
                path: toRelativeEntry(root, target),
                type: 'binary',
                encoding: 'base64',
                content: fs.readFileSync(target).toString('base64'),
                size: stat.size,
            };
        }

        return {
            path: toRelativeEntry(root, target),
            type: 'text',
            encoding: 'utf8',
            content: fs.readFileSync(target, 'utf8'),
            size: stat.size,
        };
    } catch (error) {
        throw mapFsError(error, entryPath);
    }
}

export async function readFileAt(sandboxId: string, entryPath: string): Promise<NodeFsReadResult> {
    const root = await requireRoot(sandboxId);
    return readEntrySync(root, entryPath);
}

export async function readFilesAt(sandboxId: string, paths: string[]): Promise<NodeFsReadManyOutput> {
    const root = await requireRoot(sandboxId);
    const files: NodeFsReadResult[] = [];
    const missing: string[] = [];
    let totalBytes = 0;

    for (const entryPath of paths) {
        let size: number;
        try {
            const target = resolveEntryPath(root, entryPath, false);
            size = fs.statSync(target).size;
        } catch {
            missing.push(entryPath);
            continue;
        }

        if (size > READ_MANY_MAX_FILE_BYTES || totalBytes + size > READ_MANY_MAX_TOTAL_BYTES) {
            missing.push(entryPath);
            continue;
        }

        try {
            files.push(readEntrySync(root, entryPath));
            totalBytes += size;
        } catch {
            missing.push(entryPath);
        }
    }

    return { files, missing };
}

export async function writeFileAt(sandboxId: string, input: NodeFsWriteInput): Promise<void> {
    const root = await requireRoot(sandboxId);

    try {
        const target = resolveEntryPath(root, input.path, false);
        if (fs.existsSync(target) && !input.overwrite) {
            throw new TRPCError({
                code: 'CONFLICT',
                message: `File already exists: ${input.path}`,
            });
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (input.encoding === 'base64') {
            fs.writeFileSync(target, Buffer.from(input.content, 'base64'));
        } else {
            fs.writeFileSync(target, input.content, 'utf8');
        }
    } catch (error) {
        throw mapFsError(error, input.path);
    }
}

export async function renameEntry(
    sandboxId: string,
    oldPath: string,
    newPath: string,
): Promise<void> {
    const root = await requireRoot(sandboxId);

    try {
        const source = resolveEntryPath(root, oldPath, false);
        const target = resolveEntryPath(root, newPath, false);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
    } catch (error) {
        throw mapFsError(error, oldPath);
    }
}

export async function removeEntry(
    sandboxId: string,
    entryPath: string,
    recursive?: boolean,
): Promise<void> {
    const root = await requireRoot(sandboxId);

    try {
        const target = resolveEntryPath(root, entryPath, false);
        fs.rmSync(target, { recursive: recursive ?? false, force: false });
    } catch (error) {
        throw mapFsError(error, entryPath);
    }
}

export async function mkdirChain(sandboxId: string, dirPath: string): Promise<void> {
    const root = await requireRoot(sandboxId);

    try {
        const target = resolveEntryPath(root, dirPath, false);
        fs.mkdirSync(target, { recursive: true });
    } catch (error) {
        throw mapFsError(error, dirPath);
    }
}

export async function copyEntry(
    sandboxId: string,
    sourcePath: string,
    targetPath: string,
    recursive?: boolean,
    overwrite?: boolean,
): Promise<void> {
    const root = await requireRoot(sandboxId);

    try {
        const source = resolveEntryPath(root, sourcePath, false);
        const target = resolveEntryPath(root, targetPath, false);

        let sourceStat: fs.Stats;
        try {
            sourceStat = fs.statSync(source);
        } catch (error) {
            throw mapFsError(error, sourcePath);
        }

        if (sourceStat.isDirectory() && !recursive) {
            throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Recursive must be true when copying directories',
            });
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(source, target, {
            recursive: true,
            force: overwrite ?? false,
            errorOnExist: !(overwrite ?? false),
        });
    } catch (error) {
        throw mapFsError(error, sourcePath);
    }
}

// ─── Server-side transport (for provider instances inside the Next server) ───

export function createServerNodeFsTransport(): NodeFsTransport {
    return {
        listTree: (sandboxId) => listTree(sandboxId).then((entries) => ({ entries })),
        list: (sandboxId, entryPath) => listDir(sandboxId, entryPath).then((entries) => ({ entries })),
        stat: (sandboxId, entryPath) => statEntry(sandboxId, entryPath),
        read: (sandboxId, entryPath) => readFileAt(sandboxId, entryPath),
        readMany: (sandboxId, paths) => readFilesAt(sandboxId, paths),
        write: (sandboxId, input) => writeFileAt(sandboxId, input),
        rename: (sandboxId, oldPath, newPath) => renameEntry(sandboxId, oldPath, newPath),
        remove: (sandboxId, entryPath, recursive) => removeEntry(sandboxId, entryPath, recursive),
        mkdir: (sandboxId, dirPath) => mkdirChain(sandboxId, dirPath),
        copy: (sandboxId, sourcePath, targetPath, recursive, overwrite) =>
            copyEntry(sandboxId, sourcePath, targetPath, recursive, overwrite),
    };
}
