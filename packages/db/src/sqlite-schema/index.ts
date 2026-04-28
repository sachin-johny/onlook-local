import { relations } from 'drizzle-orm';
import {
    sqliteTable,
    text,
    integer,
    primaryKey,
    index,
} from 'drizzle-orm/sqlite-core';

// ─── Auth Users (stub — mirrors auth.users from Supabase) ─────────────

export const authUsers = sqliteTable('auth_users', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    emailConfirmedAt: integer('email_confirmed_at', { mode: 'timestamp' }),
    rawUserMetaData: text('raw_user_meta_data', { mode: 'json' }),
});

// ─── Users ───────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    stripeCustomerId: text('stripe_customer_id'),
    githubInstallationId: text('github_installation_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ─── Projects ────────────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description'),
    tags: text('tags').$defaultFn(() => '[]'),
    previewImgUrl: text('preview_img_url'),
    previewImgPath: text('preview_img_path'),
    previewImgBucket: text('preview_img_bucket'),
    updatedPreviewImgAt: integer('updated_preview_img_at', { mode: 'timestamp' }),
    sandboxId: text('sandbox_id'),
    sandboxUrl: text('sandbox_url'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ─── Branches ────────────────────────────────────────────────────────

export const branches = sqliteTable('branches', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sandboxId: text('sandbox_id').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    gitBranch: text('git_branch'),
    gitCommitSha: text('git_commit_sha'),
    gitRepoUrl: text('git_repo_url'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (table) => [
    index('branches_project_id_idx').on(table.projectId),
]);

// ─── Canvases ────────────────────────────────────────────────────────

export const canvases = sqliteTable('canvas', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
});

// ─── Frames ──────────────────────────────────────────────────────────

export const frames = sqliteTable('frames', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
    branchId: text('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    x: text('x').notNull(),
    y: text('y').notNull(),
    width: text('width').notNull(),
    height: text('height').notNull(),
    type: text('type').$defaultFn(() => 'root'),
});

// ─── User-Project ────────────────────────────────────────────────────

export const userProjects = sqliteTable('user_projects', {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
}, (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
]);

// ─── User Settings ───────────────────────────────────────────────────

export const userSettings = sqliteTable('user_settings', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    autoApplyCode: integer('auto_apply_code', { mode: 'boolean' }).notNull().default(true),
    expandCodeBlocks: integer('expand_code_blocks', { mode: 'boolean' }).notNull().default(true),
    showSuggestions: integer('show_suggestions', { mode: 'boolean' }).notNull().default(true),
    showMiniChat: integer('show_mini_chat', { mode: 'boolean' }).notNull().default(false),
    shouldWarnDelete: integer('should_warn_delete', { mode: 'boolean' }).notNull().default(true),
});

// ─── User Canvas ─────────────────────────────────────────────────────

export const userCanvases = sqliteTable('user_canvases', {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
    scale: text('scale').notNull(),
    x: text('x').notNull(),
    y: text('y').notNull(),
}, (table) => [
    primaryKey({ columns: [table.userId, table.canvasId] }),
]);

// ─── Chat ────────────────────────────────────────────────────────────

export const conversations = sqliteTable('conversations', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    agentType: text('agent_type', { enum: ['root', 'user'] }).default('root'),
    suggestions: text('suggestions').$defaultFn(() => '[]'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const messages = sqliteTable('messages', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    context: text('context').$defaultFn(() => '[]'),
    parts: text('parts').$defaultFn(() => '[]'),
    checkpoints: text('checkpoints').$defaultFn(() => '[]'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ─── Project Settings ────────────────────────────────────────────────

export const projectSettings = sqliteTable('project_settings', {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    runCommand: text('run_command').notNull().default(''),
    buildCommand: text('build_command').notNull().default(''),
    installCommand: text('install_command').notNull().default(''),
});

// ─── Project Invitations (stub) ──────────────────────────────────────

export const projectInvitations = sqliteTable('project_invitations', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email'),
    role: text('role', { enum: ['owner', 'admin'] }).notNull(),
    token: text('token'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// ─── Project Create Requests (stub) ──────────────────────────────────

export const projectCreateRequests = sqliteTable('project_create_requests', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    context: text('context').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    status: text('status').notNull().default('pending'),
});

// ─── Subscriptions (stubs — billing not used in local mode) ──────────

export const subscriptions = sqliteTable('subscriptions', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeSubscriptionItemId: text('stripe_subscription_item_id'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionScheduleId: text('stripe_subscription_schedule_id'),
    status: text('status'),
    productId: text('product_id'),
    priceId: text('price_id'),
    scheduledPriceId: text('scheduled_price_id'),
    scheduledChangeAt: integer('scheduled_change_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const products = sqliteTable('products', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    stripeProductId: text('stripe_product_id'),
    name: text('name'),
});

export const prices = sqliteTable('prices', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    stripePriceId: text('stripe_price_id'),
    productId: text('product_id'),
    amount: integer('amount'),
    currency: text('currency'),
    interval: text('interval'),
});

export const legacySubscriptions = sqliteTable('legacy_subscriptions', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text('email'),
    redeemAt: integer('redeem_at', { mode: 'timestamp' }),
});

// ─── Domain Stubs ────────────────────────────────────────────────────

export const previewDomains = sqliteTable('preview_domains', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    domain: text('domain'),
});

export const projectCustomDomains = sqliteTable('project_custom_domains', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    customDomainId: text('custom_domain_id'),
    status: text('status'),
});

export const customDomains = sqliteTable('custom_domains', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    domain: text('domain'),
});

export const customDomainVerification = sqliteTable('custom_domain_verification', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    customDomainId: text('custom_domain_id'),
    projectId: text('project_id'),
    status: text('status'),
});

export const deployments = sqliteTable('deployments', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type'),
    status: text('status'),
    url: text('url'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const rateLimits = sqliteTable('rate_limits', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp' }).notNull(),
    max: integer('max').notNull(),
    left: integer('left').notNull().default(0),
    carryOverKey: text('carry_over_key').notNull(),
    carryOverTotal: integer('carry_over_total').notNull().default(0),
    stripeSubscriptionItemId: text('stripe_subscription_item_id').notNull(),
});

export const usageRecords = sqliteTable('usage_records', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('message'),
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
    traceId: text('trace_id'),
});

export const feedback = sqliteTable('feedback', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id'),
    content: text('content'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// ─── Relations ───────────────────────────────────────────────────────

export const authUsersRelations = relations(authUsers, ({ one }) => ({
    user: one(users, {
        fields: [authUsers.id],
        references: [users.id],
    }),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
    userCanvases: many(userCanvases),
    userProjects: many(userProjects),
    userSettings: one(userSettings),
    subscriptions: many(subscriptions),
    usageRecords: many(usageRecords),
    projectInvitations: many(projectInvitations),
    authUser: one(authUsers, {
        fields: [users.id],
        references: [authUsers.id],
    }),
}));

export const projectRelations = relations(projects, ({ one, many }) => ({
    canvas: one(canvases, {
        fields: [projects.id],
        references: [canvases.projectId],
    }),
    userProjects: many(userProjects),
    conversations: many(conversations),
    projectInvitations: many(projectInvitations),
    projectCustomDomains: many(projectCustomDomains),
    previewDomains: many(previewDomains),
    settings: one(projectSettings, {
        fields: [projects.id],
        references: [projectSettings.projectId],
    }),
    branches: many(branches),
}));

export const branchRelations = relations(branches, ({ one, many }) => ({
    project: one(projects, {
        fields: [branches.projectId],
        references: [projects.id],
    }),
    frames: many(frames),
}));

export const canvasRelations = relations(canvases, ({ one, many }) => ({
    frames: many(frames),
    userCanvases: many(userCanvases),
    project: one(projects, {
        fields: [canvases.projectId],
        references: [projects.id],
    }),
}));

export const frameRelations = relations(frames, ({ one }) => ({
    canvas: one(canvases, {
        fields: [frames.canvasId],
        references: [canvases.id],
    }),
    branch: one(branches, {
        fields: [frames.branchId],
        references: [branches.id],
    }),
}));

export const userProjectsRelations = relations(userProjects, ({ one }) => ({
    user: one(users, {
        fields: [userProjects.userId],
        references: [users.id],
    }),
    project: one(projects, {
        fields: [userProjects.projectId],
        references: [projects.id],
    }),
}));

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
    user: one(users, {
        fields: [userSettings.userId],
        references: [users.id],
    }),
}));

export const userCanvasesRelations = relations(userCanvases, ({ one }) => ({
    user: one(users, {
        fields: [userCanvases.userId],
        references: [users.id],
    }),
    canvas: one(canvases, {
        fields: [userCanvases.canvasId],
        references: [canvases.id],
    }),
}));

export const conversationRelations = relations(conversations, ({ one, many }) => ({
    project: one(projects, {
        fields: [conversations.projectId],
        references: [projects.id],
    }),
    messages: many(messages),
}));

export const messageRelations = relations(messages, ({ one }) => ({
    conversation: one(conversations, {
        fields: [messages.conversationId],
        references: [conversations.id],
    }),
}));

export const projectSettingsRelations = relations(projectSettings, ({ one }) => ({
    project: one(projects, {
        fields: [projectSettings.projectId],
        references: [projects.id],
    }),
}));

export const projectInvitationsRelations = relations(projectInvitations, ({ one }) => ({
    project: one(projects, {
        fields: [projectInvitations.projectId],
        references: [projects.id],
    }),
}));

export const subscriptionRelations = relations(subscriptions, ({ one }) => ({
    user: one(users, {
        fields: [subscriptions.userId],
        references: [users.id],
    }),
    product: one(products, {
        fields: [subscriptions.productId],
        references: [products.id],
    }),
    price: one(prices, {
        fields: [subscriptions.priceId],
        references: [prices.id],
    }),
}));

export const previewDomainsRelations = relations(previewDomains, ({ one }) => ({
    project: one(projects, {
        fields: [previewDomains.projectId],
        references: [projects.id],
    }),
}));

export const rateLimitsRelations = relations(rateLimits, ({ one }) => ({
    user: one(users, {
        fields: [rateLimits.userId],
        references: [users.id],
    }),
    subscription: one(subscriptions, {
        fields: [rateLimits.subscriptionId],
        references: [subscriptions.id],
    }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
    user: one(users, {
        fields: [usageRecords.userId],
        references: [users.id],
    }),
}));

export const projectCustomDomainsRelations = relations(projectCustomDomains, ({ one }) => ({
    project: one(projects, {
        fields: [projectCustomDomains.projectId],
        references: [projects.id],
    }),
}));

// ─── Types ───────────────────────────────────────────────────────────

export type LocalUser = typeof users.$inferSelect;
export type NewLocalUser = typeof users.$inferInsert;
