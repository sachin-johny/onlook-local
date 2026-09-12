/**
 * Disk I/O contract for the NodeFs provider.
 *
 * The provider runs in the browser, so actual filesystem access is delegated to a
 * transport implementation injected through `NodeFsProviderOptions`. The browser
 * implementation proxies to the `localFs` tRPC router; a server-side implementation
 * backed by `node:fs` exists in `apps/web/client/src/server/api/services/local-fs.ts`.
 *
 * All paths are sandbox-relative POSIX paths without a leading slash (e.g. `src/app/page.tsx`).
 * Binary content travels as base64 — superjson would serialize a `Uint8Array` as a
 * plain number array, which inflates the payload 4-8x.
 */

export interface NodeFsTransportEntry {
    path: string;
    type: 'file' | 'directory';
    size?: number;
}

export interface NodeFsReadResult {
    path: string;
    type: 'text' | 'binary';
    encoding: 'utf8' | 'base64';
    content: string;
    size?: number;
}

export interface NodeFsWriteInput {
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
    overwrite?: boolean;
}

export interface NodeFsReadManyOutput {
    files: NodeFsReadResult[];
    missing: string[];
}

export interface NodeFsListOutput {
    entries: NodeFsTransportEntry[];
}

export interface NodeFsTreeOutput {
    entries: NodeFsTransportEntry[];
}

export interface NodeFsTransport {
    /** Every file and directory under the sandbox root, ignored directories pruned. */
    listTree(sandboxId: string): Promise<NodeFsTreeOutput>;
    /** Immediate children of one directory. */
    list(sandboxId: string, path: string): Promise<NodeFsListOutput>;
    stat(sandboxId: string, path: string): Promise<NodeFsTransportEntry>;
    read(sandboxId: string, path: string): Promise<NodeFsReadResult>;
    /** Bulk read. Files over the per-call size cap are reported in `missing`. */
    readMany(sandboxId: string, paths: string[]): Promise<NodeFsReadManyOutput>;
    write(sandboxId: string, input: NodeFsWriteInput): Promise<void>;
    rename(sandboxId: string, oldPath: string, newPath: string): Promise<void>;
    remove(sandboxId: string, path: string, recursive?: boolean): Promise<void>;
    mkdir(sandboxId: string, path: string): Promise<void>;
    copy(
        sandboxId: string,
        sourcePath: string,
        targetPath: string,
        recursive?: boolean,
        overwrite?: boolean,
    ): Promise<void>;
}
