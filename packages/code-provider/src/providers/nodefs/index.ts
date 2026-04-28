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

export interface NodeFsProviderOptions {
    sandboxId?: string;
    userId?: string;
    previewUrl?: string;
}

interface NodeFsStoredFile {
    path: string;
    content: string | Uint8Array;
    type: 'text' | 'binary';
}

interface NodeFsProjectState {
    sandboxId: string;
    directories: Set<string>;
    files: Map<string, NodeFsStoredFile>;
    watchers: Set<NodeFsFileWatcher>;
    previewUrl: string;
}

interface NodeFsPersistedFile {
    path: string;
    type: 'text' | 'binary';
    content: string | number[];
}

interface NodeFsPersistedProjectState {
    version: 1;
    sandboxId: string;
    previewUrl: string;
    directories: string[];
    files: NodeFsPersistedFile[];
}

const DEFAULT_PREVIEW_URL =
    process.env.NEXT_PUBLIC_LOCAL_PREVIEW_URL?.trim() || 'http://localhost:8084';
const STORAGE_KEY_PREFIX = '__onlook_nodefs_project__';

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

const cloneContent = (content: string | Uint8Array) => {
    if (typeof content === 'string') {
        return content;
    }

    return new Uint8Array(content);
};

const contentToString = (content: string | Uint8Array) => {
    if (typeof content === 'string') {
        return content;
    }

    try {
        return new TextDecoder().decode(content);
    } catch {
        return '';
    }
};

const ensureParentDirectories = (project: NodeFsProjectState, path: string) => {
    project.directories.add('/');

    let current = dirname(path);
    while (current !== '/') {
        project.directories.add(current);
        current = dirname(current);
    }

    project.directories.add('/');
};

const emitWatchEvent = async (project: NodeFsProjectState, event: WatchEvent) => {
    await Promise.all(
        Array.from(project.watchers).map((watcher) => watcher.emit(event)),
    );
};

const getStorageKey = (sandboxId: string) => `${STORAGE_KEY_PREFIX}:${sandboxId}`;

const getBrowserStorage = () => {
    try {
        const maybeStorage = (globalThis as { localStorage?: unknown }).localStorage;
        if (
            maybeStorage &&
            typeof maybeStorage === 'object' &&
            'getItem' in maybeStorage &&
            'setItem' in maybeStorage &&
            'removeItem' in maybeStorage
        ) {
            return maybeStorage as {
                getItem: (key: string) => string | null;
                setItem: (key: string, value: string) => void;
                removeItem: (key: string) => void;
            };
        }
    } catch {
        return null;
    }

    return null;
};

const persistProjectState = (project: NodeFsProjectState) => {
    const storage = getBrowserStorage();
    if (!storage) {
        return;
    }

    const payload: NodeFsPersistedProjectState = {
        version: 1,
        sandboxId: project.sandboxId,
        previewUrl: project.previewUrl,
        directories: Array.from(project.directories),
        files: Array.from(project.files.values()).map((file) => ({
            path: file.path,
            type: file.type,
            content:
                file.type === 'text'
                    ? contentToString(file.content)
                    : Array.from(file.content instanceof Uint8Array ? file.content : new TextEncoder().encode(file.content)),
        })),
    };

    try {
        storage.setItem(getStorageKey(project.sandboxId), JSON.stringify(payload));
    } catch {
        // Ignore storage quota and serialization failures.
    }
};

const loadProjectState = (sandboxId: string): NodeFsProjectState | null => {
    const storage = getBrowserStorage();
    if (!storage) {
        return null;
    }

    try {
        const raw = storage.getItem(getStorageKey(sandboxId));
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw) as NodeFsPersistedProjectState;
        if (parsed.version !== 1 || !Array.isArray(parsed.directories) || !Array.isArray(parsed.files)) {
            return null;
        }

        const files = new Map<string, NodeFsStoredFile>();
        for (const file of parsed.files) {
            const normalizedPath = normalizePath(file.path);
            if (file.type === 'text') {
                files.set(normalizedPath, {
                    path: normalizedPath,
                    type: 'text',
                    content: typeof file.content === 'string' ? file.content : '',
                });
                continue;
            }

            if (!Array.isArray(file.content)) {
                continue;
            }

            files.set(normalizedPath, {
                path: normalizedPath,
                type: 'binary',
                content: new Uint8Array(file.content),
            });
        }

        const directories = new Set<string>(parsed.directories.map((dir) => normalizePath(dir)));
        directories.add('/');

        return {
            sandboxId,
            directories,
            files,
            watchers: new Set(),
            previewUrl: parsed.previewUrl || DEFAULT_PREVIEW_URL,
        };
    } catch {
        return null;
    }
};

const deletePersistedProjectState = (sandboxId: string) => {
    const storage = getBrowserStorage();
    if (!storage) {
        return;
    }

    try {
        storage.removeItem(getStorageKey(sandboxId));
    } catch {
        // ignore storage errors
    }
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
                persistProjectState(existing);
            }
            return existing;
        }

        const hydrated = loadProjectState(sandboxId);
        if (hydrated) {
            if (previewUrl) {
                hydrated.previewUrl = previewUrl;
                persistProjectState(hydrated);
            }

            NodeFsProvider.projects.set(sandboxId, hydrated);
            return hydrated;
        }

        const created: NodeFsProjectState = {
            sandboxId,
            directories: new Set(['/']),
            files: new Map(),
            watchers: new Set(),
            previewUrl: previewUrl || DEFAULT_PREVIEW_URL,
        };

        NodeFsProvider.projects.set(sandboxId, created);
        persistProjectState(created);
        return created;
    }

    async initialize(input: InitializeInput): Promise<InitializeOutput> {
        this.project = NodeFsProvider.getProjectState(this.sandboxId, this.options.previewUrl);
        return {};
    }

    async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
        const path = normalizePath(input.args.path);
        const existing = this.project.files.get(path);

        if (existing && !input.args.overwrite) {
            throw new Error(`File already exists: ${path}`);
        }

        ensureParentDirectories(this.project, path);
        this.project.files.set(path, {
            path,
            content: cloneContent(input.args.content),
            type: typeof input.args.content === 'string' ? 'text' : 'binary',
        });

        await emitWatchEvent(this.project, {
            type: existing ? 'change' : 'add',
            paths: [toRelativePath(path)],
        });
        persistProjectState(this.project);

        return {
            success: true,
        };
    }

    async renameFile(input: RenameFileInput): Promise<RenameFileOutput> {
        const oldPath = normalizePath(input.args.oldPath);
        const newPath = normalizePath(input.args.newPath);

        if (this.project.files.has(oldPath)) {
            const file = this.project.files.get(oldPath);
            if (!file) {
                throw new Error(`File not found: ${oldPath}`);
            }

            this.project.files.delete(oldPath);
            ensureParentDirectories(this.project, newPath);
            this.project.files.set(newPath, {
                ...file,
                path: newPath,
            });

            await emitWatchEvent(this.project, {
                type: 'change',
                paths: [toRelativePath(oldPath), toRelativePath(newPath)],
            });
            persistProjectState(this.project);

            return {};
        }

        if (!this.project.directories.has(oldPath)) {
            throw new Error(`Path not found: ${oldPath}`);
        }

        const movedDirectories = Array.from(this.project.directories)
            .filter((dir) => dir === oldPath || dir.startsWith(`${oldPath}/`))
            .sort((a, b) => a.length - b.length);

        for (const directory of movedDirectories) {
            this.project.directories.delete(directory);
            const remapped = directory === oldPath ? newPath : directory.replace(oldPath, newPath);
            this.project.directories.add(remapped);
        }

        const movedFiles = Array.from(this.project.files.entries()).filter(
            ([filePath]) => filePath === oldPath || filePath.startsWith(`${oldPath}/`),
        );

        for (const [filePath, file] of movedFiles) {
            this.project.files.delete(filePath);
            const remapped = filePath === oldPath ? newPath : filePath.replace(oldPath, newPath);
            this.project.files.set(remapped, {
                ...file,
                path: remapped,
            });
        }

        await emitWatchEvent(this.project, {
            type: 'change',
            paths: [toRelativePath(oldPath), toRelativePath(newPath)],
        });
        persistProjectState(this.project);

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
        if (!file) {
            throw new Error(`Path not found: ${path}`);
        }

        return {
            type: 'file',
            size: typeof file.content === 'string' ? file.content.length : file.content.byteLength,
        };
    }

    async deleteFiles(input: DeleteFilesInput): Promise<DeleteFilesOutput> {
        const path = normalizePath(input.args.path);

        if (this.project.files.has(path)) {
            this.project.files.delete(path);
            await emitWatchEvent(this.project, {
                type: 'remove',
                paths: [toRelativePath(path)],
            });
            persistProjectState(this.project);
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
        persistProjectState(this.project);

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
        const file = this.project.files.get(path);
        if (!file) {
            throw new Error(`File not found: ${path}`);
        }

        if (file.type === 'text') {
            return {
                file: {
                    path: toRelativePath(path),
                    content: typeof file.content === 'string' ? file.content : contentToString(file.content),
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
                : new Uint8Array(file.content);

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

        if (this.project.files.has(sourcePath)) {
            const sourceFile = this.project.files.get(sourcePath);
            if (!sourceFile) {
                throw new Error(`Source file not found: ${sourcePath}`);
            }

            if (!input.args.overwrite && this.project.files.has(targetPath)) {
                throw new Error(`Target file already exists: ${targetPath}`);
            }

            ensureParentDirectories(this.project, targetPath);
            this.project.files.set(targetPath, {
                ...sourceFile,
                path: targetPath,
                content: cloneContent(sourceFile.content),
            });
            await emitWatchEvent(this.project, {
                type: 'add',
                paths: [toRelativePath(targetPath)],
            });
            persistProjectState(this.project);
            return {};
        }

        if (!this.project.directories.has(sourcePath)) {
            throw new Error(`Source path not found: ${sourcePath}`);
        }

        if (!input.args.recursive) {
            throw new Error('Recursive must be true when copying directories');
        }

        const subDirectories = Array.from(this.project.directories)
            .filter((dirPath) => dirPath === sourcePath || dirPath.startsWith(`${sourcePath}/`))
            .sort((a, b) => a.length - b.length);

        for (const dirPath of subDirectories) {
            const remapped =
                dirPath === sourcePath
                    ? targetPath
                    : dirPath.replace(sourcePath, targetPath);
            this.project.directories.add(remapped);
        }

        const copiedFiles = Array.from(this.project.files.entries()).filter(
            ([filePath]) => filePath === sourcePath || filePath.startsWith(`${sourcePath}/`),
        );

        for (const [filePath, file] of copiedFiles) {
            const remapped =
                filePath === sourcePath
                    ? targetPath
                    : filePath.replace(sourcePath, targetPath);
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
        persistProjectState(this.project);

        return {};
    }

    async createDirectory(input: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        const path = normalizePath(input.args.path);
        ensureParentDirectories(this.project, path);
        this.project.directories.add(path);

        await emitWatchEvent(this.project, {
            type: 'add',
            paths: [toRelativePath(path)],
        });
        persistProjectState(this.project);

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
        return {
            task: new NodeFsTask(this.sandboxId, this.project.previewUrl),
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
        return {};
    }

    async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
        return {
            previewUrl: this.project.previewUrl,
        };
    }

    async reload(): Promise<boolean> {
        // TODO: Implement
        return true;
    }

    async reconnect(): Promise<void> {
        // TODO: Implement
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
        NodeFsProvider.projects.delete(this.sandboxId);
        deletePersistedProjectState(this.sandboxId);
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
        // TODO: Implement
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

    constructor(
        private readonly sandboxId: string,
        private readonly previewUrl: string,
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
        return 'npm run dev';
    }

    open(): Promise<string> {
        const output = `[nodefs:${this.sandboxId}] Local preview expected at ${this.previewUrl}`;
        this.emit(output);
        return Promise.resolve(output);
    }

    run(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] Run requested for ${this.command}`);
        return Promise.resolve();
    }

    async restart(): Promise<void> {
        const reachable = await isPreviewReachable(this.previewUrl);
        if (!reachable) {
            this.emit(
                `[nodefs:${this.sandboxId}] Preview is unreachable at ${this.previewUrl}. Start your imported app dev server and retry.`,
            );
            return;
        }

        this.emit(`[nodefs:${this.sandboxId}] Preview is reachable at ${this.previewUrl}`);
    }

    stop(): Promise<void> {
        this.emit(`[nodefs:${this.sandboxId}] Stop requested`);
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
