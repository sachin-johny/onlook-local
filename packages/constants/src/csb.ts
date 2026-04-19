import type { SandboxTemplate } from '@onlook/models';

export enum Templates {
    BLANK = 'BLANK',
    EMPTY_NEXTJS = 'EMPTY_NEXTJS',
}

export const SandboxTemplates: Record<Templates, SandboxTemplate> = {
    BLANK: {
        id: 'xzsy8c',
        port: 3000,
    },
    EMPTY_NEXTJS: {
        id: 'pt_EphPmsurimGCQdiB44wa7s',
        port: 3000,
    },
};

export const CSB_PREVIEW_TASK_NAME = 'dev';
export const CSB_DOMAIN = 'csb.app';

export function getSandboxPreviewUrl(sandboxId: string, port: number) {
    const localMode =
        process.env.ONLOOK_LOCAL_MODE === 'true' ||
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true';

    if (localMode) {
        return process.env.NEXT_PUBLIC_LOCAL_PREVIEW_URL?.trim() || 'http://localhost:8084';
    }

    return `https://${sandboxId}-${port}.${CSB_DOMAIN}`;
}
