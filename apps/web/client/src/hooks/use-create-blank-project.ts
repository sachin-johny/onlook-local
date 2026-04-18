'use client';

import { useAuthContext } from '@/app/auth/auth-context';
import { api } from '@/trpc/react';
import { LocalForageKeys, Routes } from '@/utils/constants';
import { LOCAL_DEV_USER_ID } from '@/utils/local-mode';
import { SandboxTemplates, Templates } from '@onlook/constants';
import localforage from 'localforage';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

const withTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(timeoutMessage));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
};

export function useCreateBlankProject() {
    const isLocalMode = process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true';
    const { data: user, error: userError } = api.user.get.useQuery();
    const { mutateAsync: forkSandbox } = api.sandbox.fork.useMutation();
    const { mutateAsync: createProject } = api.project.create.useMutation();
    const { setIsAuthModalOpen } = useAuthContext();
    const router = useRouter();
    const [isCreatingProject, setIsCreatingProject] = useState(false);

    const handleStartBlankProject = async () => {
        if (isLocalMode && userError) {
            toast.error('Local database is unavailable', {
                description: 'Start your local backend database and try again.',
            });
            return;
        }

        const userId = user?.id ?? (isLocalMode ? LOCAL_DEV_USER_ID : null);
        if (!userId) {
            // Store the return URL and open auth modal
            await localforage.setItem(LocalForageKeys.RETURN_URL, window.location.pathname);
            setIsAuthModalOpen(true);
            return;
        }

        setIsCreatingProject(true);
        try {
            // Create a blank project using the BLANK template
            const { sandboxId, previewUrl } = await withTimeout(
                forkSandbox({
                    sandbox: SandboxTemplates[Templates.EMPTY_NEXTJS],
                    config: {
                        title: `Blank project - ${userId}`,
                        tags: ['blank', userId],
                    },
                }),
                30000,
                'Sandbox creation timed out. Please try again.',
            );

            const newProject = await withTimeout(
                createProject({
                    project: {
                        name: 'New Project',
                        description: 'Your new blank project',
                        tags: ['blank'],
                    },
                    sandboxId,
                    sandboxUrl: previewUrl,
                    userId,
                }),
                30000,
                'Project creation timed out. Please verify your local database is running.',
            );

            if (newProject) {
                router.push(`${Routes.PROJECT}/${newProject.id}`);
            }
        } catch (error) {
            console.error('Error creating blank project:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);

            if (errorMessage.includes('502') || errorMessage.includes('sandbox')) {
                toast.error('Sandbox service temporarily unavailable', {
                    description: 'Please try again in a few moments. Our servers may be experiencing high load.',
                });
            } else {
                toast.error('Failed to create project', {
                    description: errorMessage,
                });
            }
        } finally {
            setIsCreatingProject(false);
        }
    };

    return { handleStartBlankProject, isCreatingProject };
}
