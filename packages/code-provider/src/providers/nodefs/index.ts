import {
    Provider,
    ProviderBackgroundCommand,
    ProviderFileWatcher,
    ProviderTask,
    ProviderTerminal,
    type CopyFileOutput,
    type CopyFilesInput,
    type CreateDirectoryInput,
    type CreateDirectoryOutput,
    type CreateProjectInput,
    type CreateProjectOutput,
    type CreateSessionInput,
    type CreateSessionOutput,
    type CreateTerminalInput,
    type CreateTerminalOutput,
    type DeleteFilesInput,
    type DeleteFilesOutput,
    type DownloadFilesInput,
    type DownloadFilesOutput,
    type GetTaskInput,
    type GetTaskOutput,
    type GitStatusInput,
    type GitStatusOutput,
    type InitializeInput,
    type InitializeOutput,
    type ListFilesInput,
    type ListFilesOutput,
    type ListProjectsInput,
    type ListProjectsOutput,
    type PauseProjectInput,
    type PauseProjectOutput,
    type ReadFileInput,
    type ReadFileOutput,
    type RenameFileInput,
    type RenameFileOutput,
    type SetupInput,
    type SetupOutput,
    type StatFileInput,
    type StatFileOutput,
    type StopProjectInput,
    type StopProjectOutput,
    type TerminalBackgroundCommandInput,
    type TerminalBackgroundCommandOutput,
    type TerminalCommandInput,
    type TerminalCommandOutput,
    type WatchEvent,
    type WatchFilesInput,
    type WatchFilesOutput,
    type WriteFileInput,
    type WriteFileOutput,
} from '../../types';
import type {
    NodeFsReadResult,
    NodeFsTransport,
} from './transport';
import { isBinaryFile } from '@onlook/utility';

export interface NodeFsProviderOptions {
    sandboxId?: string;
    userId?: string;
    previewUrl?: string;
    /**
     * Disk I/O bridge. The provider itself runs in the browser and cannot touch the
     * filesystem — callers inject a transport (tRPC-backed in the app, node:fs-backed
     * on the server). Without one, file operations fail with a clear error.
     */
    transport?: NodeFsTransport;
}

interface NodeFsStoredFile {
    path: string;
    content: string | Uint8Array | null;
    type: 'text' | 'binary';
    size?: number;
}

interface NodeFsProjectState {
    sandboxId: string;
    directories: Set<string>;
    files: Map<string, NodeFsStoredFile>;
    watchers: Set<NodeFsFileWatcher>;
    previewUrl: string;
    hydrated: boolean;
}

const DEFAULT_PREVIEW_URL =
    process.env.NEXT_PUBLIC_LOCAL_PREVIEW_URL?.trim() || 'http://localhost:8084';

// Bulk hydration caps — mirrors the readMany limits in the localFs service.
const SNAPSHOT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_BATCH_BYTES = 3 * 1024 * 1024;
const SNAPSHOT_MAX_BATCH_PATHS = 200;

const toSandboxId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `local-${crypto.randomUUID()}`;
    }

    return `local-${Math.random().toString(36).slice(2, 12)}`;
};

const normalizePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || trimmed === '.' || trimmed === './') {
        return '/';
    }

    let normalized = trimmed.replaceAll('\\', '/');
    normalized = normalized.replace(/^\.\//, '');
    normalized = normalized.replace(/\/+/g, '/');

    if (!normalized.startsWith('/')) {
        normalized = `/${normalized}`;
    }

    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
};

const dirname = (path: string) => {
    const normalized = normalizePath(path);
    if (normalized === '/') {
        return '/';
    }

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
        return '/';
    }

    return normalized.slice(0, lastSlash);
};

const toRelativePath = (path: string) => {
    const normalized = normalizePath(path);
    if (normalized === '/') {
        return './';
    }
    return normalized.startsWith('/') ? normalized.slice(1) : normalized;
};

const cloneContent = (content: string | Uint8Array | null) => {
    if (content === null || typeof content === 'string') {
        return content;
    }

    return new Uint8Array(content);
};

const contentToString = (content: string | Uint8Array | null) => {
    if (content === null) {
        return '';
    }
    if (typeof content === 'string') {
        return content;
    }

    try {
        return new TextDecoder().decode(content);
    } catch {
        return '';
    }
};

const toBase64 = (content: string | Uint8Array): string => {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

const decodeReadResult = (result: NodeFsReadResult): string | Uint8Array => {
    if (result.encoding === 'base64') {
        return fromBase64(result.content);
    }
    return result.content;
};

const byteLength = (content: string | Uint8Array | null) => {
    if (content === null) {
        return undefined;
    }
    return typeof content === 'string' ? content.length : content.byteLength;
};

const remapPath = (path: string, oldPath: string, newPath: string) => {
    return path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
};

const ensureParentDirectories = (directories: Set<string>, path: string) => {
    directories.add('/');

    let current = dirname(path);
    while (current !== '/') {
        directories.add(current);
        current = dirname(current);
    }

    directories.add('/');
};

const emitWatchEvent = async (project: NodeFsProjectState, event: WatchEvent) => {
    await Promise.all(
        Array.from(project.watchers).map((watcher) => watcher.emit(event)),
    );
};

const canUseFetch = () => {
    return typeof (globalThis as { fetch?: unknown }).fetch === 'function';
};

const isPreviewReachable = async (previewUrl: string) => {
    if (!canUseFetch()) {
        return true;
    }

    const fetchFn = (globalThis as {
        fetch?: (input: string, init?: Record<string, unknown>) => Promise<unknown>;
    }).fetch;

    if (!fetchFn) {
        return true;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
        await fetchFn(previewUrl, {
            cache: 'no-store',
            mode: 'no-cors',
            signal: controller.signal,
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
};

export class NodeFsProvider extends Provider {
    private static readonly projects = new Map<string, NodeFsProjectState>();

    private readonly options: NodeFsProviderOptions;
    private readonly sandboxId: string;
    private project: NodeFsProjectState;
    private devTask: NodeFsTask | null = null;

    constructor(options: NodeFsProviderOptions) {
        super();
        this.options = options;
        this.sandboxId = options.sandboxId ?? toSandboxId();
        this.project = NodeFsProvider.getProjectState(this.sandboxId, options.previewUrl);
    }

    private static getProjectState(sandboxId: string, previewUrl?: string): NodeFsProjectState {
        const existing = NodeFsProvider.projects.get(sandboxId);
        if (existing) {
            if (previewUrl) {
                existing.previewUrl = previewUrl;
            }
            return existing;
        }

        const created: NodeFsProjectState = {
            sandboxId,
            directories: new Set(['/']),
            files: new Map(),
            watchers: new Set(),
            previewUrl: previewUrl || DEFAULT_PREVIEW_URL,
            hydrated: false,
        };

        NodeFsProvider.projects.set(sandboxId, created);
        return created;
    }

    private requireTransport(): NodeFsTransport {
        const transport = this.options.transport;
        if (!transport) {
            throw new Error(
                'NodeFs provider has no transport configured. Inject one via NodeFsProviderOptions.transport.',
            );
        }
        return transport;
    }

    /**
     * Whether the mapped disk file already holds exactly this content. Identical writes
     * (sync re-pushes, preload script re-copies, config re-injections) are skipped so the
     * user's dev server does not see mtime-only changes and reload frames needlessly.
     */
    private async isRemoteContentIdentical(
        path: string,
        content: string | Uint8Array,
    ): Promise<boolean> {
        try {
            const result = await this.requireTransport().read(this.sandboxId, toRelativePath(path));
            const incomingBase64 = toBase64(content);
            const diskBase64 =
                result.encoding === 'base64' ? result.content : toBase64(result.content);
            return diskBase64 === incomingBase64;
        } catch {
            return false;
        }
    }

    /**
     * Pull the full listing from disk and bulk-read file contents in size-capped
     * batches. Files that are too large (or hit the per-call cap) stay in the cache
     * without content and are single-read on demand by `readFile`.
     */
    private async refreshSnapshot(): Promise<void> {
        const transport = this.requireTransport();
        const { entries } = await transport.listTree(this.sandboxId);

        const directories = new Set<string>(['/']);
        const files = new Map<string, NodeFsStoredFile>();
        const pendingPaths: string[] = [];
        const pendingSizes = new Map<string, number>();

        for (const entry of entries) {
            const normalized = normalizePath(`/${entry.path}`);
            if (entry.type === 'directory') {
                directories.add(normalized);
                continue;
            }

            files.set(normalized, {
                path: normalized,
                type: isBinaryFile(normalized) ? 'binary' : 'text',
                content: null,
                size: entry.size,
            });
            pendingPaths.push(entry.path);
            pendingSizes.set(entry.path, entry.size ?? 0);
            ensureParentDirectories(directories, normalized);
        }

        // Group into readMany batches within the transport caps.
        const batches: string[][] = [];
        let currentBatch: string[] = [];
        let currentBytes = 0;

        for (const entryPath of pendingPaths) {
            const size = pendingSizes.get(entryPath) ?? 0;
            if (size > SNAPSHOT_MAX_FILE_BYTES) {
                continue;
            }
            if (
                currentBatch.length >= SNAPSHOT_MAX_BATCH_PATHS ||
                currentBytes + size > SNAPSHOT_MAX_BATCH_BYTES
            ) {
                if (currentBatch.length > 0) {
                    batches.push(currentBatch);
                }
                currentBatch = [];
                currentBytes = 0;
            }
            currentBatch.push(entryPath);
            currentBytes += size;
        }
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        for (const batch of batches) {
            try {
                const { files: readFiles } = await transport.readMany(this.sandboxId, batch);
                for (const readResult of readFiles) {
                    const normalized = normalizePath(`/${readResult.path}`);
                    const existing = files.get(normalized);
                    files.set(normalized, {
                        path: normalized,
                        type: readResult.type,
                        content: decodeReadResult(readResult),
                        size: readResult.size ?? existing?.size,
                    });
                }
            } catch (error) {
                // Batch failed — files stay without content and fall back to single reads.
                console.warn('[nodefs] Snapshot batch read failed:', error);
            }
        }

        this.project.directories = directories;
        this.project.files = files;
        this.project.hydrated = true;
    }

    private async refreshSnapshotBestEffort(): Promise<void> {
        try {
            await this.refreshSnapshot();
        } catch (error) {
            // Unmapped or unreachable sandbox: the editor still opens with an empty
            // file tree and surfaces errors when individual operations are attempted.
            console.warn('[nodefs] Snapshot refresh skipped:', error);
        }
    }

    async initialize(input: InitializeInput): Promise<InitializeOutput> {
        this.project = NodeFsProvider.getProjectState(this.sandboxId, this.options.previewUrl);
        await this.refreshSnapshotBestEffort();
        return {};
    }

    async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
        const path = normalizePath(input.args.path);
        const existing = this.project.files.get(path);
        const isIdentical = await this.isRemoteContentIdentical(path, input.args.content);

        if (existing && !input.args.overwrite && !isIdentical) {
            throw new Error(`File already exists: ${path}`);
        }

        if (isIdentical) {
            // Disk already matches: refresh the cache but skip the write and the
            // watch event so nothing downstream sees a phantom change.
            ensureParentDirectories(this.project.directories, path);
            this.project.files.set(path, {
                path,
                content: cloneContent(input.args.content),
                type: typeof input.args.content === 'string' ? 'text' : 'binary',
                size: byteLength(input.args.content),
            });
            return {
                success: true,
            };
        }

        const encodedContent =
            typeof input.args.content === 'string'
                ? { content: input.args.content, encoding: 'utf8' as const }
                : { content: toBase64(input.args.content), encoding: 'base64' as const };

        await this.requireTransport().write(this.sandboxId, {
            path: toRelativePath(path),
            ...encodedContent,
            overwrite: input.args.overwrite,
        });

        ensureParentDirectories(this.project.directories, path);
        this.project.files.set(path, {
            path,
            content: cloneContent(input.args.content),
            type: encodedContent.encoding === 'base64' ? 'binary' : 'text',
            size: byteLength(input.args.content),
        });

        await emitWatchEvent(this.project, {
            type: existing ? 'change' : 'add',
            paths: [toRelativePath(path)],
        });

        return {
            success: true,
        };
    }

    async renameFile(input: RenameFileInput): Promise<RenameFileOutput> {
        const oldPath = normalizePath(input.args.oldPath);
        const newPath = normalizePath(input.args.newPath);

        const file = this.project.files.get(oldPath);
        if (file) {
            await this.requireTransport().rename(
                this.sandboxId,
                toRelativePath(oldPath),
                toRelativePath(newPath),
            );

            this.project.files.delete(oldPath);
            ensureParentDirectories(this.project.directories, newPath);
            this.project.files.set(newPath, {
                ...file,
                path: newPath,
            });

            await emitWatchEvent(this.project, {
                type: 'change',
                paths: [toRelativePath(oldPath), toRelativePath(newPath)],
            });

            return {};
        }

        if (!this.project.directories.has(oldPath)) {
            throw new Error(`Path not found: ${oldPath}`);
        }

        await this.requireTransport().rename(
            this.sandboxId,
            toRelativePath(oldPath),
            toRelativePath(newPath),
        );

        const movedDirectories = Array.from(this.project.directories)
            .filter((dir) => dir === oldPath || dir.startsWith(`${oldPath}/`))
            .sort((a, b) => a.length - b.length);

        for (const directory of movedDirectories) {
            this.project.directories.delete(directory);
            this.project.directories.add(remapPath(directory, oldPath, newPath));
        }

        const movedFiles = Array.from(this.project.files.entries()).filter(
            ([filePath]) => filePath === oldPath || filePath.startsWith(`${oldPath}/`),
        );

        for (const [filePath, moved] of movedFiles) {
            this.project.files.delete(filePath);
            this.project.files.set(remapPath(filePath, oldPath, newPath), {
                ...moved,
                path: remapPath(filePath, oldPath, newPath),
            });
        }

        await emitWatchEvent(this.project, {
            type: 'change',
            paths: [toRelativePath(oldPath), toRelativePath(newPath)],
        });

        return {};
    }

    async statFile(input: StatFileInput): Promise<StatFileOutput> {
        const path = normalizePath(input.args.path);

        if (this.project.directories.has(path)) {
            return {
                type: 'directory',
            };
        }

        const file = this.project.files.get(path);
        if (file) {
            return {
                type: 'file',
                size: file.size ?? byteLength(file.content),
            };
        }

        // Unknown to the snapshot (pruned or created externally) — ask the transport.
        const entry = await this.requireTransport().stat(this.sandboxId, toRelativePath(path));
        if (entry.type === 'directory') {
            ensureParentDirectories(this.project.directories, path);
            this.project.directories.add(path);
            return { type: 'directory' };
        }

        this.project.files.set(path, {
            path,
            type: isBinaryFile(path) ? 'binary' : 'text',
            content: null,
            size: entry.size,
        });
        return {
            type: 'file',
            size: entry.size,
        };
    }

    async deleteFiles(input: DeleteFilesInput): Promise<DeleteFilesOutput> {
        const path = normalizePath(input.args.path);

        if (this.project.files.has(path)) {
            await this.requireTransport().remove(this.sandboxId, toRelativePath(path), false);
            this.project.files.delete(path);
            await emitWatchEvent(this.project, {
                type: 'remove',
                paths: [toRelativePath(path)],
            });
            return {};
        }

        if (!this.project.directories.has(path)) {
            return {};
        }

        const hasNestedEntries =
            Array.from(this.project.files.keys()).some((filePath) => filePath.startsWith(`${path}/`)) ||
            Array.from(this.project.directories).some(
                (dirPath) => dirPath !== path && dirPath.startsWith(`${path}/`),
            );

        if (!input.args.recursive && hasNestedEntries) {
            throw new Error(`Directory is not empty: ${path}`);
        }

        await this.requireTransport().remove(
            this.sandboxId,
            toRelativePath(path),
            input.args.recursive === true || hasNestedEntries,
        );

        for (const filePath of Array.from(this.project.files.keys())) {
            if (filePath === path || filePath.startsWith(`${path}/`)) {
                this.project.files.delete(filePath);
            }
        }

        for (const dirPath of Array.from(this.project.directories)) {
            if (dirPath === path || dirPath.startsWith(`${path}/`)) {
                this.project.directories.delete(dirPath);
            }
        }

        this.project.directories.add('/');

        await emitWatchEvent(this.project, {
            type: 'remove',
            paths: [toRelativePath(path)],
        });

        return {};
    }

    async listFiles(input: ListFilesInput): Promise<ListFilesOutput> {
        const path = normalizePath(input.args.path);

        if (!this.project.directories.has(path) && path !== '/') {
            if (this.project.files.has(path)) {
                return {
                    files: [],
                };
            }

            throw new Error(`Directory not found: ${path}`);
        }

        const nextEntries = new Map<string, 'file' | 'directory'>();
        const prefix = path === '/' ? '/' : `${path}/`;

        for (const dir of this.project.directories) {
            if (!dir.startsWith(prefix) || dir === path) {
                continue;
            }
            const remaining = dir.slice(prefix.length);
            const immediate = remaining.split('/')[0];
            if (immediate) {
                nextEntries.set(immediate, 'directory');
            }
        }

        for (const filePath of this.project.files.keys()) {
            if (!filePath.startsWith(prefix)) {
                continue;
            }
            const remaining = filePath.slice(prefix.length);
            const immediate = remaining.split('/')[0];
            if (!immediate) {
                continue;
            }

            if (!nextEntries.has(immediate)) {
                const fullChildPath = normalizePath(`${path}/${immediate}`);
                nextEntries.set(
                    immediate,
                    this.project.directories.has(fullChildPath) ? 'directory' : 'file',
                );
            }
        }

        return {
            files: Array.from(nextEntries.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, type]) => ({
                    name,
                    type,
                    isSymlink: false,
                })),
        };
    }

    async readFile(input: ReadFileInput): Promise<ReadFileOutput> {
        const path = normalizePath(input.args.path);
        let file = this.project.files.get(path);

        if (!file) {
            const result = await this.requireTransport().read(this.sandboxId, toRelativePath(path));
            file = {
                path,
                type: result.type,
                content: decodeReadResult(result),
                size: result.size,
            };
            this.project.files.set(path, file);
            ensureParentDirectories(this.project.directories, path);
        } else if (file.content === null) {
            const result = await this.requireTransport().read(this.sandboxId, toRelativePath(path));
            file.content = decodeReadResult(result);
            file.type = result.type;
            file.size = result.size ?? file.size;
        }

        if (file.type === 'text') {
            return {
                file: {
                    path: toRelativePath(path),
                    content: contentToString(file.content),
                    type: 'text',
                    toString: () => {
                        return contentToString(file.content);
                    },
                },
            };
        }

        const binaryContent =
            typeof file.content === 'string'
                ? new TextEncoder().encode(file.content)
                : new Uint8Array(file.content ?? new Uint8Array());

        return {
            file: {
                path: toRelativePath(path),
                content: binaryContent,
                type: 'binary',
                toString: () => {
                    return contentToString(file.content);
                },
            },
        };
    }

    async downloadFiles(input: DownloadFilesInput): Promise<DownloadFilesOutput> {
        return {
            url: this.project.previewUrl,
        };
    }

    async copyFiles(input: CopyFilesInput): Promise<CopyFileOutput> {
        const sourcePath = normalizePath(input.args.sourcePath);
        const targetPath = normalizePath(input.args.targetPath);

        const sourceFile = this.project.files.get(sourcePath);
        if (sourceFile) {
            if (!input.args.overwrite && this.project.files.has(targetPath)) {
                throw new Error(`Target file already exists: ${targetPath}`);
            }

            await this.requireTransport().copy(
                this.sandboxId,
                toRelativePath(sourcePath),
                toRelativePath(targetPath),
                false,
                input.args.overwrite,
            );

            ensureParentDirectories(this.project.directories, targetPath);
            this.project.files.set(targetPath, {
                ...sourceFile,
                path: targetPath,
                content: cloneContent(sourceFile.content),
            });
            await emitWatchEvent(this.project, {
                type: 'add',
                paths: [toRelativePath(targetPath)],
            });
            return {};
        }

        if (!this.project.directories.has(sourcePath)) {
            throw new Error(`Source path not found: ${sourcePath}`);
        }

        if (!input.args.recursive) {
            throw new Error('Recursive must be true when copying directories');
        }

        await this.requireTransport().copy(
            this.sandboxId,
            toRelativePath(sourcePath),
            toRelativePath(targetPath),
            true,
            input.args.overwrite,
        );

        const copiedDirectories = Array.from(this.project.directories)
            .filter((dirPath) => dirPath === sourcePath || dirPath.startsWith(`${sourcePath}/`))
            .sort((a, b) => a.length - b.length);

        for (const dirPath of copiedDirectories) {
            this.project.directories.add(remapPath(dirPath, sourcePath, targetPath));
        }

        const copiedFiles = Array.from(this.project.files.entries()).filter(
            ([filePath]) => filePath === sourcePath || filePath.startsWith(`${sourcePath}/`),
        );

        for (const [filePath, file] of copiedFiles) {
            const remapped = remapPath(filePath, sourcePath, targetPath);
            this.project.files.set(remapped, {
                ...file,
                path: remapped,
                content: cloneContent(file.content),
            });
        }

        await emitWatchEvent(this.project, {
            type: 'add',
            paths: [toRelativePath(targetPath)],
        });

        return {};
    }

    async createDirectory(input: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        const path = normalizePath(input.args.path);

        await this.requireTransport().mkdir(this.sandboxId, toRelativePath(path));

        ensureParentDirectories(this.project.directories, path);
        this.project.directories.add(path);

        await emitWatchEvent(this.project, {
            type: 'add',
            paths: [toRelativePath(path)],
        });

        return {};
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        const watcher = new NodeFsFileWatcher(this.project);
        await watcher.start(input);

        if (input.onFileChange) {
            watcher.registerEventCallback(input.onFileChange);
        }

        return {
            watcher,
        };
    }

    async createTerminal(input: CreateTerminalInput): Promise<CreateTerminalOutput> {
        return {
            terminal: new NodeFsTerminal(this.sandboxId),
        };
    }

    async getTask(input: GetTaskInput): Promise<GetTaskOutput> {
        // One shared dev-task instance per provider: the terminal session and
        // restartDevServer() must see the same output stream.
        if (!this.devTask) {
            this.devTask = new NodeFsTask(
                this.sandboxId,
                this.project.previewUrl,
                this.requireTransport(),
            );
        }
        return {
            task: this.devTask,
        };
    }

    async runCommand(input: TerminalCommandInput): Promise<TerminalCommandOutput> {
        return {
            output: `[nodefs:${this.sandboxId}] command execution is not available in local mode`,
        };
    }

    async runBackgroundCommand(
        input: TerminalBackgroundCommandInput,
    ): Promise<TerminalBackgroundCommandOutput> {
        return {
            command: new NodeFsCommand(this.sandboxId),
        };
    }

    async gitStatus(input: GitStatusInput): Promise<GitStatusOutput> {
        return {
            changedFiles: [],
        };
    }

    async setup(input: SetupInput): Promise<SetupOutput> {
        await this.refreshSnapshotBestEffort();
        return {};
    }

    async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
        return {
            previewUrl: this.project.previewUrl,
        };
    }

    async reload(): Promise<boolean> {
        await this.refreshSnapshotBestEffort();
        return true;
    }

    async reconnect(): Promise<void> {
        await this.refreshSnapshotBestEffort();
    }

    async ping(): Promise<boolean> {
        return isPreviewReachable(this.project.previewUrl);
    }

    static async createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
        const id = toSandboxId();
        NodeFsProvider.getProjectState(id);
        return {
            id,
        };
    }

    static async createProjectFromGit(input: {
        repoUrl: string;
        branch: string;
    }): Promise<CreateProjectOutput> {
        const id = toSandboxId();
        NodeFsProvider.getProjectState(id);
        return {
            id,
        };
    }

    async pauseProject(input: PauseProjectInput): Promise<PauseProjectOutput> {
        return {};
    }

    async stopProject(input: StopProjectInput): Promise<StopProjectOutput> {
        // In-memory only — the mapped disk folder must never be touched.
        NodeFsProvider.projects.delete(this.sandboxId);
        return {};
    }

    async listProjects(input: ListProjectsInput): Promise<ListProjectsOutput> {
        return {
            projects: Array.from(NodeFsProvider.projects.values()).map((project) => ({
                id: project.sandboxId,
                name: project.sandboxId,
                description: 'Local NodeFs sandbox',
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
        };
    }

    async destroy(): Promise<void> {
        // Keep the cached snapshot — reopening the project should not force a full re-read.
    }
}

export class NodeFsFileWatcher extends ProviderFileWatcher {
    private input: WatchFilesInput | null = null;
    private callback: ((event: WatchEvent) => Promise<void>) | null = null;
    private active = false;

    constructor(private readonly project: NodeFsProjectState) {
        super();
    }

    start(input: WatchFilesInput): Promise<void> {
        this.input = input;
        this.active = true;
        this.project.watchers.add(this);
        return Promise.resolve();
    }

    stop(): Promise<void> {
        this.active = false;
        this.project.watchers.delete(this);
        return Promise.resolve();
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        this.callback = callback;
    }

    async emit(event: WatchEvent): Promise<void> {
        if (!this.active || !this.callback || !this.input) {
            return;
        }

        const watchedPath = normalizePath(this.input.args.path || './');
        const excludes = this.input.args.excludes ?? [];

        const inScope = event.paths.some((path) => {
            const normalized = normalizePath(path);
            const matchesWatchRoot =
                watchedPath === '/' || normalized === watchedPath || normalized.startsWith(`${watchedPath}/`);
            const excluded = excludes.some((exclude) => normalized.includes(exclude.replace('/**', '')));
            return matchesWatchRoot && !excluded;
        });

        if (!inScope) {
            return;
        }

        await this.callback(event);
    }
}

export class NodeFsTerminal extends ProviderTerminal {
    private readonly terminalId: string;
    private callbacks = new Set<(data: string) => void>();

    constructor(private readonly sandboxId: string) {
        super();
        this.terminalId = `${sandboxId}-terminal`;
    }

    get id(): string {
        return this.terminalId;
    }

    get name(): string {
        return `terminal-${this.sandboxId}`;
    }

    open(): Promise<string> {
        const output = `[nodefs:${this.sandboxId}] interactive shell is not available`;
        this.emit(output);
        return Promise.resolve(output);
    }

    write(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] write ignored`);
        return Promise.resolve();
    }

    run(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] run ignored`);
        return Promise.resolve();
    }

    kill(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] terminal closed`);
        return Promise.resolve();
    }

    onOutput(callback: (data: string) => void): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    private emit(data: string) {
        for (const callback of this.callbacks) {
            callback(`${data}\n`);
        }
    }
}

export class NodeFsTask extends ProviderTask {
    private readonly taskId: string;
    private callbacks = new Set<(data: string) => void>();
    private emittedLogCount = 0;

    constructor(
        private readonly sandboxId: string,
        private readonly previewUrl: string,
        private readonly transport: NodeFsTransport,
    ) {
        super();
        this.taskId = `${sandboxId}-dev`;
    }

    get id(): string {
        return this.taskId;
    }

    get name(): string {
        return 'dev';
    }

    get command(): string {
        return 'dev';
    }

    /**
     * Status report for the terminal tab. The server is started via `restart()`
     * (the Restart Sandbox button) — opening the terminal never spawns processes.
     */
    async open(): Promise<string> {
        let output = `[nodefs:${this.sandboxId}] Local preview expected at ${this.previewUrl}`;
        try {
            const status = await this.transport.serverStatus(this.sandboxId);
            if (status.running) {
                output = `[nodefs:${this.sandboxId}] Dev server running (pid ${status.pid ?? '?'}): ${status.command} → ${this.previewUrl}`;
            } else if (status.exitCode !== null) {
                output += `\n[nodefs:${this.sandboxId}] Dev server exited (code ${status.exitCode}). Use restart to start it.`;
            } else {
                output += `\n[nodefs:${this.sandboxId}] Dev server is not running. Use restart to start it.`;
            }
            this.emit(output);
            this.emitLogTail(status.logs);
            return output;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.emit(`${output}\n[nodefs:${this.sandboxId}] Failed to query dev server status: ${message}`);
            return output;
        }
    }

    run(): Promise<void> {
        return this.restart();
    }

    /** Start the dev server (stopping any running instance first), then wait until it serves. */
    async restart(): Promise<void> {
        const status = await this.transport.serverStatus(this.sandboxId);
        if (status.running) {
            this.emit(`[nodefs:${this.sandboxId}] Stopping the running dev server…`);
            await this.transport.serverStop(this.sandboxId);
            this.emittedLogCount = 0;
        }

        this.emit(`[nodefs:${this.sandboxId}] Starting dev server at ${this.previewUrl}…`);
        const started = await this.transport.serverStart(this.sandboxId, this.previewPort());
        this.emit(`[nodefs:${this.sandboxId}] ${started.command} (pid ${started.pid ?? '?'})`);
        await this.waitForReady();
    }

    stop(): Promise<void> {
        return this.transport.serverStop(this.sandboxId).then((status) => {
            this.emit(`[nodefs:${this.sandboxId}] Dev server stopped`);
            this.emitLogTail(status.logs);
        });
    }

    onOutput(callback: (data: string) => void): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    private previewPort(): number | undefined {
        try {
            const port = new URL(this.previewUrl).port;
            return port ? Number(port) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Stream log deltas into the terminal while polling until the preview answers.
     * Cold `npm run dev` on a large project can take a while — allow 90s.
     */
    private async waitForReady(): Promise<void> {
        const timeoutMs = 90_000;
        const pollMs = 1_000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const status = await this.transport.serverStatus(this.sandboxId);
            this.emitLogTail(status.logs);
            if (status.exitCode !== null) {
                throw new Error(`Dev server exited with code ${status.exitCode}`);
            }
            if (await isPreviewReachable(this.previewUrl)) {
                this.emit(`[nodefs:${this.sandboxId}] Dev server is up at ${this.previewUrl}`);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        throw new Error(
            `Dev server did not become reachable at ${this.previewUrl} within ${timeoutMs / 1000}s`,
        );
    }

    private emitLogTail(logs: string[]) {
        const fresh = logs.slice(Math.min(this.emittedLogCount, logs.length));
        for (const line of fresh) {
            this.emit(line);
        }
        this.emittedLogCount = logs.length;
    }

    private emit(data: string) {
        for (const callback of this.callbacks) {
            callback(`${data}\n`);
        }
    }
}

export class NodeFsCommand extends ProviderBackgroundCommand {
    private callbacks = new Set<(data: string) => void>();

    constructor(private readonly sandboxId: string) {
        super();
    }

    get name(): string {
        return `command-${this.sandboxId}`;
    }

    get command(): string {
        return 'noop';
    }

    open(): Promise<string> {
        const output = `[nodefs:${this.sandboxId}] background command is not available`;
        this.emit(output);
        return Promise.resolve(output);
    }

    restart(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] restart ignored`);
        return Promise.resolve();
    }

    kill(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] background command stopped`);
        return Promise.resolve();
    }

    onOutput(callback: (data: string) => void): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    private emit(data: string) {
        for (const callback of this.callbacks) {
            callback(`${data}\n`);
        }
    }
}
