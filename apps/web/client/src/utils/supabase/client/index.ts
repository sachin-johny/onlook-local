import { env } from '@/env';
import { createBrowserClient } from '@supabase/ssr';

type BrowserSupabaseClient = ReturnType<typeof createBrowserClient>;

function createLocalClient(): BrowserSupabaseClient {
    const localUser = {
        id: 'local-dev-user',
        email: 'dev@local.dev',
        user_metadata: {
            name: 'Local Dev User',
            avatar_url: '',
        },
    };

    const localSession = {
        access_token: 'local-dev-token',
        refresh_token: 'local-dev-refresh-token',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: localUser,
    };

    return {
        auth: {
            getSession: async () => ({
                data: { session: localSession },
                error: null,
            }),
            getUser: async () => ({
                data: { user: localUser },
                error: null,
            }),
            signOut: async () => ({
                error: null,
            }),
            onAuthStateChange: () => ({
                data: {
                    subscription: {
                        unsubscribe: () => { },
                    },
                },
            }),
        },
        storage: {
            from: () => ({
                upload: async () => ({ data: { path: '' }, error: null }),
                getPublicUrl: () => ({ data: { publicUrl: '' } }),
                info: async () => ({ data: null, error: null }),
            }),
        },
    } as unknown as BrowserSupabaseClient;
}

export function createClient() {
    if (env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE) {
        return createLocalClient();
    }

    // Create a supabase client on the browser with project's credentials
    return createBrowserClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
}

export const getFileUrlFromStorage = (bucket: string, path: string) => {
    const supabase = createClient();
    const { data } = supabase.storage
        .from(bucket)
        .getPublicUrl(path);

    return data.publicUrl;
};

export const getFileInfoFromStorage = async (bucket: string, path: string) => {
    const supabase = createClient();
    const { data, error } = await supabase.storage
        .from(bucket).info(path);
    if (error) {
        console.error('Error getting file info:', error);
        return null;
    }
    return data;
};

export const uploadBlobToStorage = async (bucket: string, path: string, file: Blob, options: {
    upsert?: boolean;
    contentType?: string;
    cacheControl?: string;
}) => {
    const supabase = createClient();
    const { data, error } = await supabase.storage
        .from(bucket)
        .upload(path, file, options);

    if (error) {
        console.error('Error uploading file:', error);
        return null;
    }

    return data;
};