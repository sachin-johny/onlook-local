# Onlook: Remove All External API Dependencies
### Goal: Run 100% locally → then add LangChain/Esperanto LLM layer

---

## Overview

Onlook's current external dependencies that block local-only usage:

| Dependency | Purpose | Blocks App? | Removal Strategy |
|---|---|---|---|
| **Supabase** | Auth + DB + Storage | ✅ Yes (redirects to login) | Stub client + bypass middleware |
| **CodeSandbox SDK** | Dev container runtime | ✅ Yes (project creation fails) | Replace with local Docker |
| **OpenRouter** | LLM provider | ⚠️ Partial (AI chat errors) | Stub → later replace with LangChain |
| **Morph / Relace Fast Apply** | Code apply model | ⚠️ Partial (apply errors) | Stub → later replace with LangChain |
| **Freestyle** | Deployment/hosting | ❌ No (deploy button only) | Stub or remove deploy button |

---

## Phase 1: Kill All ENV Crashes (5 minutes)

Before touching any code, create a `.env.local` with fake values so the app doesn't crash on startup when it tries to read missing env vars.

```bash
# apps/web/.env.local  (or root .env.local)

# --- Supabase (fake — will be stubbed in code) ---
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon-key-bypass
SUPABASE_SERVICE_ROLE_KEY=fake-service-role-key-bypass

# --- CodeSandbox (fake — will be stubbed in code) ---
CSB_API_TOKEN=fake-csb-token

# --- OpenRouter (fake — will be replaced with LangChain) ---
OPENROUTER_API_KEY=fake-openrouter-key

# --- Fast Apply providers (fake — will be replaced) ---
MORPH_API_KEY=fake-morph-key
RELACE_API_KEY=fake-relace-key

# --- Freestyle deploy (fake — feature not needed locally) ---
FREESTYLE_API_KEY=fake-freestyle-key
```

This stops ALL "missing env var" startup crashes. The app gets further now.

---

## Phase 2: Bypass Supabase Auth (15 minutes)

### Step 1 — Bypass the auth middleware

Find `middleware.ts` in `apps/web/` (project root level):

```ts
// apps/web/middleware.ts — REPLACE ENTIRE FILE
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  // Skip all auth checks — pass every request through
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

### Step 2 — Stub the Supabase client

Find the Supabase client factory. It is usually one of:
- `packages/db/src/client.ts`
- `apps/web/lib/supabase/client.ts`
- `apps/web/utils/supabase/client.ts`

Replace the contents with a mock that returns a fake logged-in session:

```ts
// Supabase client STUB — no real Supabase needed
export const createClient = () => ({
  auth: {
    getSession: async () => ({
      data: {
        session: {
          user: { id: 'local-dev-user', email: 'dev@local.dev' },
          access_token: 'fake-token',
        },
      },
      error: null,
    }),
    getUser: async () => ({
      data: { user: { id: 'local-dev-user', email: 'dev@local.dev' } },
      error: null,
    }),
    onAuthStateChange: (_event: any, cb: any) => {
      cb('SIGNED_IN', { user: { id: 'local-dev-user' } });
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({
      data: { user: { id: 'local-dev-user' }, session: {} },
      error: null,
    }),
  },
  from: (table: string) => ({
    select: (...args: any[]) => ({
      eq: () => ({ data: [], error: null }),
      single: () => ({ data: null, error: null }),
      data: [],
      error: null,
    }),
    insert: (data: any) => ({ data, error: null }),
    update: (data: any) => ({ eq: () => ({ data, error: null }) }),
    delete: () => ({ eq: () => ({ data: null, error: null }) }),
    upsert: (data: any) => ({ data, error: null }),
  }),
  storage: {
    from: () => ({
      upload: async () => ({ data: { path: 'local' }, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
    }),
  },
});

// Also export as default if needed
export default createClient;
```

### Step 3 — Stub Drizzle ORM queries (if used)

If `packages/db/` has Drizzle queries that hit a real database, mock the db object:

```ts
// packages/db/src/index.ts — stub version
export const db = new Proxy({}, {
  get: () => new Proxy({}, {
    get: () => async () => [],  // all queries return empty array
  }),
});
```

**Test after Phase 2:** Run `bun run dev` → app should load at `localhost:3000` without redirecting to login.

---

## Phase 3: Stub CodeSandbox → Local Docker Container (30 minutes)

The CodeSandbox SDK is used to spin up a dev container when a new project is created. Find the sandbox service file — look for `codesandbox` imports:

```bash
# Find all CodeSandbox references
grep -r "codesandbox\|@codesandbox" apps/ packages/ --include="*.ts" -l
```

Replace the CodeSandbox container creation with a local Docker call:

```ts
// apps/web/server/services/sandbox.ts — REPLACEMENT

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function createSandbox(projectId: string) {
  // Start a local Node container, mount a project volume
  const containerName = `onlook-${projectId}`;
  const hostPort = await getFreePort();

  await execAsync(
    `docker run -d --name ${containerName} \
     -p ${hostPort}:3000 \
     -v /tmp/onlook-projects/${projectId}:/app \
     -w /app \
     node:20-alpine \
     sh -c "npm install && npm run dev"`
  );

  return {
    id: containerName,
    previewUrl: `http://localhost:${hostPort}`,
    status: 'running',
  };
}

export async function stopSandbox(containerId: string) {
  await execAsync(`docker stop ${containerId} && docker rm ${containerId}`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
  });
}
```

**If Docker feels heavy for just testing the UI**, use an even simpler stub that returns a fake preview URL without running anything:

```ts
// Minimal stub — just proves the UI works, no real container
export async function createSandbox(projectId: string) {
  return {
    id: `local-${projectId}`,
    previewUrl: 'http://localhost:3001', // point to any running Next.js app
    status: 'running',
  };
}
export async function stopSandbox() {}
```

---

## Phase 4: Stub OpenRouter + Fast Apply (15 minutes)

These only activate when the AI chat is used. Stub them to return a placeholder response so the UI doesn't crash — you'll replace these with LangChain later.

Find the AI call locations:

```bash
grep -r "openrouter\|openai\|ai-sdk\|streamText\|generateText" apps/ --include="*.ts" -l
```

### Stub the LLM client

```ts
// apps/web/server/services/ai.ts — STUB (replace with LangChain later)

export async function streamAIResponse(messages: any[], onChunk: (text: string) => void) {
  // Placeholder response — replace with LangChain in Phase 5
  const response = "🚧 LLM not connected yet. Add LangChain or Esperanto in Phase 5.";
  for (const char of response) {
    onChunk(char);
    await new Promise(r => setTimeout(r, 20));
  }
}
```

### Stub Fast Apply

```ts
// apps/web/server/services/fast-apply.ts — STUB

export async function applyCodeChange(original: string, diff: string): Promise<string> {
  // Naive line-by-line apply — no external API needed
  // Replace with proper LangChain tool call later
  console.log('[fast-apply stub] applying diff locally');
  return original; // return unchanged for now — or wire a local diff library
}
```

---

## Phase 5: Remove Freestyle Deploy (5 minutes)

Freestyle is only used for the "Deploy" button. Find it and either:

**Option A — Hide the button in UI:**
```tsx
// Find the Deploy button component and wrap with a flag
{process.env.NEXT_PUBLIC_ENABLE_DEPLOY === 'true' && (
  <DeployButton />
)}
```

**Option B — Stub the deploy service:**
```ts
export async function deployProject(projectId: string) {
  console.log('[deploy stub] Deploy disabled in local mode');
  return { url: null, error: 'Deploy not available in local mode' };
}
```

---

## Phase 6: Smoke Test Checklist

After all stubs are in place, verify each of these:

```
[ ] bun run dev starts with no crash
[ ] localhost:3000 loads without redirecting to login
[ ] Can navigate to editor view
[ ] Creating a new project doesn't crash (returns local container stub)
[ ] AI chat sends message without crashing (returns stub response)
[ ] No console errors about missing API keys
[ ] No TypeScript errors from missing Supabase types
```

If any step fails, check the browser console and Next.js server log for the exact import that's still referencing an external service.

---

## Phase 7: Add LangChain / Esperanto LLM (After Smoke Test Passes)

Once the app runs cleanly, replace the AI stub with a real local LLM integration.

### Option A — LangChain (most flexible, supports 50+ providers)

```bash
bun add langchain @langchain/core @langchain/openai @langchain/community
```

```ts
// apps/web/server/services/ai.ts — LangChain version
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Works with Ollama (local), OpenAI, Anthropic — just change baseURL + model
const model = new ChatOpenAI({
  modelName: 'llama3.1',              // any Ollama model
  openAIApiKey: 'ollama',             // placeholder
  configuration: {
    baseURL: 'http://localhost:11434/v1',  // Ollama local endpoint
  },
  streaming: true,
});

export async function streamAIResponse(
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void
) {
  const langchainMessages = messages.map(m =>
    m.role === 'user'
      ? new HumanMessage(m.content)
      : new SystemMessage(m.content)
  );

  const stream = await model.stream(langchainMessages);
  for await (const chunk of stream) {
    onChunk(chunk.content as string);
  }
}
```

### Option B — Esperanto (provider-agnostic, lighter weight)

```bash
bun add esperanto-llm   # or the correct package name from PyPI/npm
```

Esperanto uses a unified interface so you can swap providers in one config change:

```ts
import { LLMClient } from 'esperanto-llm';

const client = new LLMClient({
  provider: 'ollama',          // change to 'openai', 'anthropic', 'groq' etc.
  model: 'llama3.1:8b',
  baseUrl: 'http://localhost:11434',
});

export async function streamAIResponse(messages: any[], onChunk: (text: string) => void) {
  const stream = await client.stream(messages);
  for await (const chunk of stream) {
    onChunk(chunk.text);
  }
}
```

### Ollama Setup (required for local LLM)

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a coding model
ollama pull qwen2.5-coder:7b      # lightweight, good for code
# OR
ollama pull llama3.1:8b           # general purpose

# Verify it's running
curl http://localhost:11434/api/tags
```

---

## Summary: Execution Order

```
1. [ ] Create .env.local with fake keys         (5 min)
2. [ ] Replace middleware.ts                     (2 min)
3. [ ] Stub Supabase client                      (10 min)
4. [ ] Stub Drizzle db if needed                 (5 min)
5. [ ] Stub CodeSandbox → local Docker/fake URL  (10 min)
6. [ ] Stub OpenRouter AI calls                  (10 min)
7. [ ] Stub Fast Apply                           (5 min)
8. [ ] Hide/stub Freestyle deploy button         (5 min)
9. [ ] Run smoke test checklist                  (10 min)
10.[ ] Replace AI stub with LangChain/Esperanto  (30 min)
```

**Total estimated time: ~1.5 hours to fully local, dependency-free Onlook.**
