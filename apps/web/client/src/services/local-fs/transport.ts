import type { NodeFsTransport } from '@onlook/code-provider';

import { api } from '@/trpc/client';

/**
 * Browser-side `NodeFsTransport` backed by the `localFs` tRPC router, which performs the
 * real disk I/O in the Next.js server. Binary content crosses the wire as base64.
 */

const BASE64_CHUNK_SIZE = 0x8000;

export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function createLocalFsHttpTransport(): NodeFsTransport {
    return {
        listTree: async (sandboxId) => {
            return await api.localFs.listTree.query({ sandboxId });
        },
        list: async (sandboxId, path) => {
            return await api.localFs.list.query({ sandboxId, path });
        },
        stat: async (sandboxId, path) => {
            return await api.localFs.stat.query({ sandboxId, path });
        },
        read: async (sandboxId, path) => {
            return await api.localFs.read.query({ sandboxId, path });
        },
        readMany: async (sandboxId, paths) => {
            // POST (mutation) — the batched path list overflows a GET URL (431).
            return await api.localFs.readMany.mutate({ sandboxId, paths });
        },
        write: async (sandboxId, input) => {
            await api.localFs.write.mutate({
                sandboxId,
                path: input.path,
                content: input.content,
                encoding: input.encoding,
                overwrite: input.overwrite,
            });
        },
        rename: async (sandboxId, oldPath, newPath) => {
            await api.localFs.rename.mutate({ sandboxId, oldPath, newPath });
        },
        remove: async (sandboxId, path, recursive) => {
            await api.localFs.remove.mutate({ sandboxId, path, recursive });
        },
        mkdir: async (sandboxId, path) => {
            await api.localFs.mkdir.mutate({ sandboxId, path });
        },
        copy: async (sandboxId, sourcePath, targetPath, recursive, overwrite) => {
            await api.localFs.copy.mutate({ sandboxId, sourcePath, targetPath, recursive, overwrite });
        },
        serverStart: async (sandboxId, port) => {
            return await api.localFs.serverStart.mutate({ sandboxId, port });
        },
        serverStop: async (sandboxId) => {
            return await api.localFs.serverStop.mutate({ sandboxId });
        },
        serverStatus: async (sandboxId) => {
            return await api.localFs.serverStatus.query({ sandboxId });
        },
    };
}

export const localFsHttpTransport = createLocalFsHttpTransport();
