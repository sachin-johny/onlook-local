/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { createAdminClient } from '@/utils/supabase/admin';
import { LOCAL_DEV_USER_EMAIL, LOCAL_DEV_USER_ID, LOCAL_DEV_USER_NAME } from '@/utils/local-mode';
import { createClient } from '@/utils/supabase/server';
import { authUsers, users, type DrizzleDb } from '@onlook/db';
import { db as pgDb } from '@onlook/db/src/client';
import { getDb as getSqliteDb, initSqliteDb } from '@onlook/db/src/sqlite-client';
import * as sqliteSchema from '@onlook/db/src/sqlite-schema';
import type { User } from '@supabase/supabase-js';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { SetRequiredDeep } from 'type-fest';
import { ZodError } from 'zod';

const ensureLocalDevUserRecords = async (db: DrizzleDb, localMode: boolean) => {
    if (localMode) {
        // SQLite mode: initSqliteDb already seeds the local dev user
        return;
    }

    // Postgres mode: insert into authUsers + users tables
    await db
        .insert(authUsers)
        .values({
            id: LOCAL_DEV_USER_ID,
            email: LOCAL_DEV_USER_EMAIL,
            emailConfirmedAt: new Date(),
            rawUserMetaData: {
                name: LOCAL_DEV_USER_NAME,
                avatar_url: '',
                avatarUrl: '',
            },
        })
        .onConflictDoNothing();

    await db
        .insert(users)
        .values({
            id: LOCAL_DEV_USER_ID,
            email: LOCAL_DEV_USER_EMAIL,
            firstName: 'Local',
            lastName: 'Dev',
            displayName: LOCAL_DEV_USER_NAME,
            avatarUrl: '',
        })
        .onConflictDoNothing();
};

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
    const localMode =
        process.env.ONLOOK_LOCAL_MODE === 'true' ||
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true';

    const db: DrizzleDb = localMode ? getSqliteDb() as unknown as DrizzleDb : pgDb;

    if (localMode) {
        await initSqliteDb();
    }

    const supabase = await createClient();
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error && !localMode) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
    }

    const contextUser =
        user ??
        (localMode
            ? ({
                id: LOCAL_DEV_USER_ID,
                email: LOCAL_DEV_USER_EMAIL,
                user_metadata: {
                    name: LOCAL_DEV_USER_NAME,
                    avatar_url: '',
                    avatarUrl: '',
                },
            } as unknown as User)
            : null);

    if (localMode && contextUser?.id === LOCAL_DEV_USER_ID) {
        try {
            await ensureLocalDevUserRecords(db, localMode);
        } catch (localUserError) {
            console.warn('Unable to seed local dev user records:', localUserError);
        }
    }

    return {
        db,
        supabase,
        user: contextUser,
        localMode,
        ...opts,
    };
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
        return {
            ...shape,
            data: {
                ...shape.data,
                zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
            },
        };
    },
});

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
    const start = Date.now();

    if (t._config.isDev) {
        // artificial delay in dev
        const waitMs = Math.floor(Math.random() * 400) + 100;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const result = await next();

    const end = Date.now();
    console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

    return result;
});

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(({ ctx, next }) => {
    if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    if (!ctx.user.email) {
        throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User must have an email address to access this resource',
        });
    }

    return next({
        ctx: {
            user: ctx.user as SetRequiredDeep<User, 'email'>,
            db: ctx.db,
            localMode: ctx.localMode,
        },
    });
});

/**
 * Admin procedure with service role access
 *
 * This procedure provides access to Supabase admin operations using the service role key.
 * Use with extreme caution as it bypasses RLS policies.
 *
 * @see https://trpc.io/docs/procedures
 */
export const adminProcedure = t.procedure.use(timingMiddleware).use(({ ctx, next }) => {
    if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    if (!ctx.user.email) {
        throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'User must have an email address to access this resource',
        });
    }

    const adminSupabase = createAdminClient();

    return next({
        ctx: {
            user: ctx.user as SetRequiredDeep<User, 'email'>,
            db: ctx.db,
            localMode: ctx.localMode,
            supabase: adminSupabase, // Override with admin client
        },
    });
});

