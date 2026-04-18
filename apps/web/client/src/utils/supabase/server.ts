import { env } from '@/env';
import { LOCAL_DEV_USER_EMAIL, LOCAL_DEV_USER_ID, LOCAL_DEV_USER_NAME } from '@/utils/local-mode';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

type ServerSupabaseClient = ReturnType<typeof createServerClient>;

function createLocalClient(): ServerSupabaseClient {
    const localUser = {
        id: LOCAL_DEV_USER_ID,
        email: LOCAL_DEV_USER_EMAIL,
        user_metadata: {
            name: LOCAL_DEV_USER_NAME,
            avatar_url: '',
            avatarUrl: '',
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
            signInWithPassword: async () => ({
                data: {
                    user: localUser,
                    session: localSession,
                },
                error: null,
            }),
            signInWithOAuth: async () => ({
                data: {
                    provider: null,
                    url: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?code=local-dev-code`,
                },
                error: null,
            }),
            exchangeCodeForSession: async () => ({
                data: {
                    session: localSession,
                    user: localUser,
                },
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
    } as unknown as ServerSupabaseClient;
}

export async function createClient() {
    if (env.ONLOOK_LOCAL_MODE) {
        return createLocalClient();
    }

    const cookieStore = await cookies();

    // Create a server's supabase client with newly configured cookie,
    // which could be used to maintain user's session
    return createServerClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options),
                        );
                    } catch {
                        // The `setAll` method was called from a Server Component.
                        // This can be ignored if you have middleware refreshing
                        // user sessions.
                    }
                },
            },
        },
    );
}
