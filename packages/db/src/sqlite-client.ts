import * as schema from '@onlook/db/src/sqlite-schema';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';

// ─── Proxy wrapper to patch PG default columns ────────────────────
// PG table objects have SQL-level defaults (gen_random_uuid(), now())
// that crash SQLite. This proxy intercepts .insert().values() and
// fills in missing id/createdAt/updatedAt with JS-generated values.

function patchDefaults(obj: Record<string, any>, id: string, now: Date): Record<string, any> {
    return {
        id: obj.id ?? id,
        createdAt: obj.createdAt ?? now,
        updatedAt: obj.updatedAt ?? now,
        startedAt: obj.startedAt ?? now,
        endedAt: obj.endedAt ?? now,
        timestamp: obj.timestamp ?? now,
        ...obj,
    };
}

function wrapBuilder(builder: any): any {
    return new Proxy(builder, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === 'values' && typeof value === 'function') {
                return function (data: any) {
                    const now = new Date();
                    const id = crypto.randomUUID();
                    if (Array.isArray(data)) {
                        return value.call(target, data.map((d: any) => patchDefaults(d, id, now)));
                    }
                    return value.call(target, patchDefaults(data, id, now));
                };
            }
            if (typeof value === 'function' && prop !== 'then') {
                return function (...args: any[]) {
                    const next = value.apply(target, args);
                    return typeof next === 'object' && next !== null ? wrapBuilder(next) : next;
                };
            }
            return value;
        },
    });
}

function wrapLocalDb(rawDb: any): any {
    return new Proxy(rawDb, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);

            // 1) Patch db.insert(...)
            if (prop === 'insert' && typeof value === 'function') {
                return function (...args: any[]) {
                    const builder = (value as Function).apply(target, args);
                    return wrapBuilder(builder);
                };
            }

            // 2) Patch db.transaction(cb => ...) so tx is also wrapped
            if (prop === 'transaction' && typeof value === 'function') {
                return function (...args: any[]) {
                    const [cb, ...rest] = args;
                    if (typeof cb !== 'function') {
                        return (value as Function).apply(target, args);
                    }
                    const wrappedCb = (tx: any, ...cbRest: any[]) => {
                        const wrappedTx = wrapLocalDb(tx);
                        return cb(wrappedTx, ...cbRest);
                    };
                    return (value as Function).apply(target, [wrappedCb, ...rest]);
                };
            }

            // Fallback: bind methods, pass through others
            return typeof value === 'function' ? (value as Function).bind(target) : value;
        },
    });
}

// Must match apps/web/client/src/utils/local-mode.ts constants
const LOCAL_DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
const LOCAL_DEV_USER_EMAIL = 'dev@local.dev';
const LOCAL_DEV_USER_NAME = 'Local Dev User';

const globalForDb = globalThis as unknown as {
    sqliteInstance: Client | undefined;
    sqliteInitialized: boolean | undefined;
};

function getSqlitePath() {
    return process.env.ONLOOK_LOCAL_DB_PATH || 'file:./onlook-local.db';
}

function getSqlite(): Client {
    if (globalForDb.sqliteInstance) return globalForDb.sqliteInstance;

    const sqlite = createClient({ url: getSqlitePath() });

    if (process.env.NODE_ENV !== 'production') {
        globalForDb.sqliteInstance = sqlite;
    }

    return sqlite;
}

export function getDb() {
    const sqlite = getSqlite();
    return wrapLocalDb(drizzle(sqlite, { schema }));
}

const CREATE_TABLES_SQL = `
    -- Auth users (Supabase stub)
    CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        email_confirmed_at INTEGER,
        raw_user_meta_data TEXT
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        first_name TEXT,
        last_name TEXT,
        display_name TEXT,
        avatar_url TEXT,
        stripe_customer_id TEXT,
        github_installation_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        tags TEXT DEFAULT '[]',
        preview_img_url TEXT,
        preview_img_path TEXT,
        preview_img_bucket TEXT,
        updated_preview_img_at INTEGER,
        sandbox_id TEXT,
        sandbox_url TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Branches
    CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        sandbox_id TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        git_commit_sha TEXT,
        git_repo_url TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS branches_project_id_idx ON branches(project_id);

    -- Canvas
    CREATE TABLE IF NOT EXISTS canvas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Frames
    CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES canvas(id) ON DELETE CASCADE,
        branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        x TEXT NOT NULL,
        y TEXT NOT NULL,
        width TEXT NOT NULL,
        height TEXT NOT NULL,
        type TEXT DEFAULT 'root'
    );

    -- User-Project junction
    CREATE TABLE IF NOT EXISTS user_projects (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, project_id)
    );

    -- User settings
    CREATE TABLE IF NOT EXISTS user_settings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auto_apply_code INTEGER NOT NULL DEFAULT 1,
        expand_code_blocks INTEGER NOT NULL DEFAULT 1,
        show_suggestions INTEGER NOT NULL DEFAULT 1,
        show_mini_chat INTEGER NOT NULL DEFAULT 0,
        should_warn_delete INTEGER NOT NULL DEFAULT 1
    );

    -- User canvas
    CREATE TABLE IF NOT EXISTS user_canvases (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        canvas_id TEXT NOT NULL REFERENCES canvas(id) ON DELETE CASCADE,
        scale TEXT NOT NULL,
        x TEXT NOT NULL,
        y TEXT NOT NULL,
        PRIMARY KEY (user_id, canvas_id)
    );

    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        display_name TEXT,
        agent_type TEXT CHECK(agent_type IN ('root', 'user')) DEFAULT 'root',
        suggestions TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        context TEXT DEFAULT '[]',
        parts TEXT DEFAULT '[]',
        checkpoints TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Project settings
    CREATE TABLE IF NOT EXISTS project_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        run_command TEXT NOT NULL DEFAULT '',
        build_command TEXT NOT NULL DEFAULT '',
        install_command TEXT NOT NULL DEFAULT ''
    );

    -- Project invitations
    CREATE TABLE IF NOT EXISTS project_invitations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT,
        role TEXT NOT NULL,
        token TEXT,
        created_at INTEGER DEFAULT (unixepoch())
    );

    -- Project create requests
    CREATE TABLE IF NOT EXISTS project_create_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        context TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        status TEXT NOT NULL DEFAULT 'pending'
    );

    -- Subscriptions (stub)
    CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_subscription_id TEXT,
        stripe_subscription_item_id TEXT,
        stripe_customer_id TEXT,
        stripe_subscription_schedule_id TEXT,
        status TEXT,
        product_id TEXT,
        price_id TEXT,
        scheduled_price_id TEXT,
        scheduled_change_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Products (stub)
    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        stripe_product_id TEXT,
        name TEXT
    );

    -- Prices (stub)
    CREATE TABLE IF NOT EXISTS prices (
        id TEXT PRIMARY KEY,
        stripe_price_id TEXT,
        product_id TEXT,
        amount INTEGER,
        currency TEXT,
        interval TEXT
    );

    -- Legacy subscriptions (stub)
    CREATE TABLE IF NOT EXISTS legacy_subscriptions (
        id TEXT PRIMARY KEY,
        email TEXT,
        redeem_at INTEGER
    );

    -- Preview domains (stub)
    CREATE TABLE IF NOT EXISTS preview_domains (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        domain TEXT
    );

    -- Project custom domains (stub)
    CREATE TABLE IF NOT EXISTS project_custom_domains (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        custom_domain_id TEXT,
        status TEXT
    );

    -- Custom domains (stub)
    CREATE TABLE IF NOT EXISTS custom_domains (
        id TEXT PRIMARY KEY,
        domain TEXT,
        apex_domain TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Custom domain verification (stub)
    CREATE TABLE IF NOT EXISTS custom_domain_verification (
        id TEXT PRIMARY KEY,
        custom_domain_id TEXT REFERENCES custom_domains(id),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        full_domain TEXT,
        freestyle_verification_id TEXT,
        txt_record TEXT,
        a_records TEXT DEFAULT '[]',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Deployments (stub)
    CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT,
        status TEXT,
        url TEXT,
        created_at INTEGER DEFAULT (unixepoch())
    );

    -- Rate limits
    CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        max INTEGER NOT NULL,
        left INTEGER NOT NULL DEFAULT 0,
        carry_over_key TEXT NOT NULL,
        carry_over_total INTEGER NOT NULL DEFAULT 0,
        stripe_subscription_item_id TEXT NOT NULL
    );

    -- Usage records
    CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'message',
        timestamp INTEGER NOT NULL,
        trace_id TEXT
    );

    -- Feedback (stub)
    CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        created_at INTEGER DEFAULT (unixepoch())
    );
    
`;

/**
 * Initialize the SQLite database: create tables and seed the local dev user.
 * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
 * Uses a shared promise so concurrent callers coalesce into one init.
 */
let initPromise: Promise<void> | undefined;

export async function initSqliteDb(): Promise<void> {
    if (globalForDb.sqliteInitialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        if (globalForDb.sqliteInitialized) return;

        const sqlite = getSqlite();

    // libsql executes batch statements sequentially
    const statements = CREATE_TABLES_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    for (const stmt of statements) {
        await sqlite.execute(stmt);
    }

    // Seed the local dev user
    const db = getDb();

    await db.insert(schema.authUsers)
        .values({
            id: LOCAL_DEV_USER_ID,
            email: LOCAL_DEV_USER_EMAIL,
            emailConfirmedAt: new Date(),
            rawUserMetaData: { name: LOCAL_DEV_USER_NAME, avatar_url: '', avatarUrl: '' },
        })
        .onConflictDoNothing();

    await db.insert(schema.users)
        .values({
            id: LOCAL_DEV_USER_ID,
            email: LOCAL_DEV_USER_EMAIL,
            firstName: 'Local',
            lastName: 'Dev',
            displayName: LOCAL_DEV_USER_NAME,
            avatarUrl: '',
        })
        .onConflictDoNothing();

        console.log(`[SQLite] Initialized local DB at ${getSqlitePath()}`);
        globalForDb.sqliteInitialized = true;
    })();

    return initPromise;
}

export type SqliteDb = ReturnType<typeof getDb>;
