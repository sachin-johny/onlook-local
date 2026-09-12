import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
    bindLocalSandbox,
    copyEntry,
    listDir,
    listTree,
    mkdirChain,
    readFileAt,
    readFilesAt,
    removeEntry,
    renameEntry,
    resolveLocalRoot,
    statEntry,
    unbindLocalSandbox,
    validateLocalPath,
    writeFileAt,
} from '../services/local-fs';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Disk I/O for local-mode sandboxes. Every procedure addressing a sandbox requires a
 * `local_sandboxes` mapping row (created on local import) — without it the sandbox is
 * not linked to a folder on disk and file operations cannot proceed.
 */

const localFsProcedure = protectedProcedure.use(({ ctx, next }) => {
    if (!ctx.localMode) {
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'The local filesystem router is only available in local mode',
        });
    }
    return next({ ctx });
});

const sandboxIdSchema = z.object({
    sandboxId: z.string().min(1),
});

export const localFsRouter = createTRPCRouter({
    validatePath: localFsProcedure
        .input(z.object({ path: z.string().min(1) }))
        .query(({ input }) => validateLocalPath(input.path)),

    bind: localFsProcedure
        .input(
            sandboxIdSchema.extend({
                localPath: z.string().min(1),
                displayName: z.string().optional(),
            }),
        )
        .mutation(({ input }) =>
            bindLocalSandbox(input.sandboxId, input.localPath, input.displayName),
        ),

    resolve: localFsProcedure
        .input(sandboxIdSchema)
        .query(async ({ input }) => {
            const localPath = await resolveLocalRoot(input.sandboxId);
            return { localPath };
        }),

    unbind: localFsProcedure
        .input(sandboxIdSchema)
        .mutation(({ input }) => unbindLocalSandbox(input.sandboxId)),

    stat: localFsProcedure
        .input(sandboxIdSchema.extend({ path: z.string() }))
        .query(({ input }) => statEntry(input.sandboxId, input.path)),

    list: localFsProcedure
        .input(sandboxIdSchema.extend({ path: z.string() }))
        .query(async ({ input }) => {
            const entries = await listDir(input.sandboxId, input.path);
            return { entries };
        }),

    listTree: localFsProcedure
        .input(sandboxIdSchema)
        .query(async ({ input }) => {
            const entries = await listTree(input.sandboxId);
            return { entries };
        }),

    read: localFsProcedure
        .input(sandboxIdSchema.extend({ path: z.string().min(1) }))
        .query(({ input }) => readFileAt(input.sandboxId, input.path)),

    // A mutation (POST) rather than a query: batched path lists overflow the URL
    // header limit as a GET — the server answered 431 on large snapshots.
    readMany: localFsProcedure
        .input(sandboxIdSchema.extend({ paths: z.array(z.string().min(1)).min(1).max(200) }))
        .mutation(({ input }) => readFilesAt(input.sandboxId, input.paths)),

    write: localFsProcedure
        .input(
            sandboxIdSchema.extend({
                path: z.string().min(1),
                content: z.string(),
                encoding: z.enum(['utf8', 'base64']).default('utf8'),
                overwrite: z.boolean().optional(),
            }),
        )
        .mutation(async ({ input }) => {
            await writeFileAt(input.sandboxId, {
                path: input.path,
                content: input.content,
                encoding: input.encoding,
                overwrite: input.overwrite,
            });
            return { success: true };
        }),

    rename: localFsProcedure
        .input(
            sandboxIdSchema.extend({
                oldPath: z.string().min(1),
                newPath: z.string().min(1),
            }),
        )
        .mutation(async ({ input }) => {
            await renameEntry(input.sandboxId, input.oldPath, input.newPath);
            return {};
        }),

    remove: localFsProcedure
        .input(
            sandboxIdSchema.extend({
                path: z.string().min(1),
                recursive: z.boolean().optional(),
            }),
        )
        .mutation(async ({ input }) => {
            await removeEntry(input.sandboxId, input.path, input.recursive);
            return {};
        }),

    mkdir: localFsProcedure
        .input(sandboxIdSchema.extend({ path: z.string().min(1) }))
        .mutation(async ({ input }) => {
            await mkdirChain(input.sandboxId, input.path);
            return {};
        }),

    copy: localFsProcedure
        .input(
            sandboxIdSchema.extend({
                sourcePath: z.string().min(1),
                targetPath: z.string().min(1),
                recursive: z.boolean().optional(),
                overwrite: z.boolean().optional(),
            }),
        )
        .mutation(async ({ input }) => {
            await copyEntry(
                input.sandboxId,
                input.sourcePath,
                input.targetPath,
                input.recursive,
                input.overwrite,
            );
            return {};
        }),
});
