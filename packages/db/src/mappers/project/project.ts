import type { PreviewImg, Project } from '@onlook/models';
import type { Project as DbProject } from '../../schema';

/**
 * Normalise a date value from either PG or SQLite drivers.
 * PG returns Date objects; SQLite with `mode: 'timestamp'` may return
 * Invalid Date (when stored as text by PG column serialisation) or a
 * raw string/integer.
 */
function safeDate(value: unknown): Date {
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? new Date() : value;
    }
    if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? new Date() : d;
    }
    if (typeof value === 'number') {
        // Heuristic: values > ~2001-09-09 in ms are already milliseconds
        return new Date(value > 1e12 ? value : value * 1000);
    }
    return new Date();
}

/**
 * Normalise tags: PG returns string[], SQLite may return a JSON string.
 */
function safeTags(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
        } catch {
            return [];
        }
    }
    return [];
}

export const fromDbProject = (
    dbProject: DbProject,
): Project => {
    return {
        id: dbProject.id,
        name: dbProject.name,
        metadata: {
            createdAt: safeDate(dbProject.createdAt),
            updatedAt: safeDate(dbProject.updatedAt),
            previewImg: fromDbPreviewImg(dbProject),
            description: dbProject.description,
            tags: safeTags(dbProject.tags),
        },
    };
};

export const toDbProject = (project: Project): DbProject => {
    const { previewImgUrl, previewImgPath, previewImgBucket, updatedPreviewImgAt } = toDbPreviewImg(project.metadata.previewImg);
    return {
        id: project.id,
        name: project.name,
        tags: project.metadata.tags ?? [],
        createdAt: project.metadata.createdAt,
        updatedAt: project.metadata.updatedAt,
        description: project.metadata.description,
        previewImgUrl,
        previewImgPath,
        previewImgBucket,
        updatedPreviewImgAt,

        // deprecated
        sandboxId: null,
        sandboxUrl: null,
    };
};

export function fromDbPreviewImg(dbProject: DbProject): PreviewImg | null {
    let previewImg: PreviewImg | null = null;
    if (dbProject.previewImgUrl) {
        previewImg = {
            type: 'url',
            url: dbProject.previewImgUrl,
            updatedAt: dbProject.updatedPreviewImgAt,
        };
    } else if (dbProject.previewImgPath && dbProject.previewImgBucket) {
        previewImg = {
            type: 'storage',
            storagePath: {
                bucket: dbProject.previewImgBucket,
                path: dbProject.previewImgPath,
            },
            updatedAt: dbProject.updatedPreviewImgAt,
        };
    }
    return previewImg;
}

export function toDbPreviewImg(previewImg: PreviewImg | null): {
    previewImgUrl: string | null,
    previewImgPath: string | null,
    previewImgBucket: string | null,
    updatedPreviewImgAt: Date | null,
} {
    let res: {
        previewImgUrl: string | null,
        previewImgPath: string | null,
        previewImgBucket: string | null,
        updatedPreviewImgAt: Date | null,
    } = {
        previewImgUrl: null,
        previewImgPath: null,
        previewImgBucket: null,
        updatedPreviewImgAt: null,
    };

    if (!previewImg) {
        return res;
    }

    if (previewImg.type === 'url' && previewImg.url) {
        res.previewImgUrl = previewImg.url;
    } else if (previewImg.type === 'storage' && previewImg.storagePath && previewImg.storagePath.path && previewImg.storagePath.bucket) {
        res.previewImgPath = previewImg.storagePath.path;
        res.previewImgBucket = previewImg.storagePath.bucket;
    }
    res.updatedPreviewImgAt = previewImg.updatedAt ?? new Date();
    return res;
}