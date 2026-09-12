'use client';

import { Icons } from '@onlook/ui/icons/index';

import { CreateProjectDialog } from '@/app/projects/_components/create-project-dialog';
import { CreatingProjectOverlay } from '@/app/projects/_components/creating-project-overlay';
import { useCreateBlankProject } from '@/hooks/use-create-blank-project';

export function StartBlank() {
    const {
        openNameDialog,
        handleStartBlankProject,
        isCreatingProject,
        isNameDialogOpen,
        setIsNameDialogOpen,
    } = useCreateBlankProject();

    return (
        <>
            <button
                onClick={openNameDialog}
                disabled={isCreatingProject}
                className="text-foreground-secondary hover:text-foreground disabled:hover:text-foreground-secondary flex items-center gap-2 text-sm transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {isCreatingProject ? (
                    <Icons.LoadingSpinner className="h-4 w-4 animate-spin" />
                ) : (
                    <Icons.File className="h-4 w-4" />
                )}
                Start a Blank Project
            </button>
            <CreateProjectDialog
                open={isNameDialogOpen}
                onClose={() => setIsNameDialogOpen(false)}
                onSubmit={handleStartBlankProject}
            />
            <CreatingProjectOverlay isVisible={isCreatingProject} />
        </>
    );
}
