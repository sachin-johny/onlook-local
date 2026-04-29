import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import {
    CodeProvider,
    createCodeProviderClient,
    getStaticCodeProvider,
} from '@onlook/code-provider';
import { getSandboxPreviewUrl, SandboxTemplates, Templates } from '@onlook/constants';
import { shortenUuid } from '@onlook/utility/src/id';

import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { getLocalProjectsDir, scaffoldProject, cleanupProject } from '../../../scaffold';

function isLocalModeEnabled() {
    return (
        process.env.ONLOOK_LOCAL_MODE === 'true' ||
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true'
    );
}

// function hasUsableCodesandboxKey() {
//     const key = process.env.CSB_API_KEY?.trim();
//     return !!key && !key.startsWith('local-');
// }

function createLocalSandbox(port: number) {
    const sandboxId = `local-${randomUUID()}`;
    return {
        sandboxId,
        previewUrl: getSandboxPreviewUrl(sandboxId, port),
    };
}

function getProvider({
    sandboxId,
    userId,
    previewUrl,
    provider = CodeProvider.CodeSandbox,
}: {
    sandboxId: string;
    previewUrl?: string;
    provider?: CodeProvider;
    userId?: undefined | string;
}) {
    if (provider === CodeProvider.CodeSandbox) {
        return createCodeProviderClient(CodeProvider.CodeSandbox, {
            providerOptions: {
                codesandbox: {
                    sandboxId,
                    userId,
                },
            },
        });
    } else {
        return createCodeProviderClient(CodeProvider.NodeFs, {
            providerOptions: {
                nodefs: {
                    sandboxId,
                    userId,
                    previewUrl,
                },
            },
        });
    }
}

export const sandboxRouter = createTRPCRouter({
    create: protectedProcedure
        .input(
            z.object({
                title: z.string().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            if (isLocalModeEnabled()) {
                const { sandboxId, previewUrl } = createLocalSandbox(3000);
                const projectsDir = getLocalProjectsDir();
                const projectDir = join(projectsDir, sandboxId);

                try {
                    await scaffoldProject(projectDir, input.title || 'my-app');
                } catch (err) {
                    await cleanupProject(projectDir).catch(() => {});
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: `Failed to scaffold local project: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }

                return { sandboxId, previewUrl };
            }

            // Create a new sandbox using the static provider
            const CodesandboxProvider = await getStaticCodeProvider(CodeProvider.CodeSandbox);

            // Use the empty Next.js template
            const template = SandboxTemplates[Templates.EMPTY_NEXTJS];

            const newSandbox = await CodesandboxProvider.createProject({
                source: 'template',
                id: template.id,
                title: input.title || 'Onlook Test Sandbox',
                description: 'Test sandbox for Onlook sync engine',
                tags: ['onlook-test'],
            });

            return {
                sandboxId: newSandbox.id,
                previewUrl: getSandboxPreviewUrl(newSandbox.id, template.port),
            };
        }),

    start: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const userId = ctx.user.id;
            const previewUrl = getSandboxPreviewUrl(input.sandboxId, 3000);
            const provider = await getProvider({
                sandboxId: input.sandboxId,
                userId,
                previewUrl,
            });
            const session = await provider.createSession({
                args: {
                    id: shortenUuid(userId, 20),
                },
            });
            await provider.destroy();
            return session;
        }),
    status: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .query(async ({ input }) => {
            const previewUrl = getSandboxPreviewUrl(input.sandboxId, 3000);

            if (isLocalModeEnabled()) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);

                try {
                    await fetch(previewUrl, {
                        cache: 'no-store',
                        mode: 'no-cors',
                        signal: controller.signal,
                    });

                    return {
                        sandboxId: input.sandboxId,
                        status: 'running' as const,
                        previewUrl,
                    };
                } catch {
                    return {
                        sandboxId: input.sandboxId,
                        status: 'unreachable' as const,
                        previewUrl,
                    };
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            return {
                sandboxId: input.sandboxId,
                status: 'running' as const,
                previewUrl,
            };
        }),
    hibernate: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input }) => {
            const provider = await getProvider({
                sandboxId: input.sandboxId,
                previewUrl: getSandboxPreviewUrl(input.sandboxId, 3000),
            });
            try {
                await provider.pauseProject({});
            } finally {
                await provider.destroy().catch(() => { });
            }
        }),
    list: protectedProcedure.input(z.object({ sandboxId: z.string() })).query(async ({ input }) => {
        const provider = await getProvider({
            sandboxId: input.sandboxId,
            previewUrl: getSandboxPreviewUrl(input.sandboxId, 3000),
        });
        const res = await provider.listProjects({});
        // TODO future iteration of code provider abstraction will need this code to be refactored
        if ('projects' in res) {
            return res.projects;
        }
        return [];
    }),
    fork: protectedProcedure
        .input(
            z.object({
                sandbox: z.object({
                    id: z.string(),
                    port: z.number(),
                }),
                config: z
                    .object({
                        title: z.string().optional(),
                        tags: z.array(z.string()).optional(),
                    })
                    .optional(),
            }),
        )
        .mutation(async ({ input }) => {
            if (isLocalModeEnabled()) {
                const { sandboxId, previewUrl } = createLocalSandbox(input.sandbox.port);
                const projectsDir = getLocalProjectsDir();
                const projectDir = join(projectsDir, sandboxId);

                try {
                    await scaffoldProject(projectDir, input.config?.title || 'my-app');
                } catch (err) {
                    await cleanupProject(projectDir).catch(() => {});
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: `Failed to scaffold local project: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }

                return { sandboxId, previewUrl };
            }

            const MAX_RETRY_ATTEMPTS = 3;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
                try {
                    const CodesandboxProvider = await getStaticCodeProvider(
                        CodeProvider.CodeSandbox,
                    );
                    const sandbox = await CodesandboxProvider.createProject({
                        source: 'template',
                        id: input.sandbox.id,

                        // Metadata
                        title: input.config?.title,
                        tags: input.config?.tags,
                    });

                    const previewUrl = getSandboxPreviewUrl(sandbox.id, input.sandbox.port);

                    return {
                        sandboxId: sandbox.id,
                        previewUrl,
                    };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));

                    if (attempt < MAX_RETRY_ATTEMPTS) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, Math.pow(2, attempt) * 1000),
                        );
                    }
                }
            }

            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to create sandbox after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`,
                cause: lastError,
            });
        }),
    delete: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input }) => {
            const provider = await getProvider({
                sandboxId: input.sandboxId,
                previewUrl: getSandboxPreviewUrl(input.sandboxId, 3000),
            });
            try {
                await provider.stopProject({});
            } finally {
                await provider.destroy().catch(() => { });
            }
        }),
    createFromGitHub: protectedProcedure
        .input(
            z.object({
                repoUrl: z.string(),
                branch: z.string(),
            }),
        )
        .mutation(async ({ input }) => {
            if (isLocalModeEnabled()) {
                const { sandboxId, previewUrl } = createLocalSandbox(3000);
                const projectsDir = getLocalProjectsDir();
                const projectDir = join(projectsDir, sandboxId);

                try {
                    await scaffoldProject(projectDir, 'my-app');
                } catch (err) {
                    await cleanupProject(projectDir).catch(() => {});
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: `Failed to scaffold local project: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }

                return { sandboxId, previewUrl };
            }

            const MAX_RETRY_ATTEMPTS = 3;
            const DEFAULT_PORT = 3000;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
                try {
                    const CodesandboxProvider = await getStaticCodeProvider(
                        CodeProvider.CodeSandbox,
                    );
                    const sandbox = await CodesandboxProvider.createProjectFromGit({
                        repoUrl: input.repoUrl,
                        branch: input.branch,
                    });

                    const previewUrl = getSandboxPreviewUrl(sandbox.id, DEFAULT_PORT);

                    return {
                        sandboxId: sandbox.id,
                        previewUrl,
                    };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));

                    if (attempt < MAX_RETRY_ATTEMPTS) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, Math.pow(2, attempt) * 1000),
                        );
                    }
                }
            }

            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to create GitHub sandbox after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`,
                cause: lastError,
            });
        }),
});
