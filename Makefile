SHELL := /bin/bash

ENV_FILE := apps/web/client/.env
ENV_LOCAL_FILE := apps/web/client/.env.local
ENV_EXAMPLE_FILE := apps/web/client/.env.example

.PHONY: help start-local stop-local start-local-sqlite local-db-reset backend-start backend-stop db-push

help:
	@echo "Usage:"
	@echo "  make start-local        # Start Supabase, push schema, run dev app"
	@echo "  make start-local-sqlite # Start with SQLite (no Supabase needed)"
	@echo "  make local-db-reset     # Delete and re-create the SQLite database"
	@echo "  make stop-local         # Stop dev app, then stop Supabase"

ensure-env:
	@bun -e "const fs = require('node:fs'); const envPath = 'apps/web/client/.env'; if (fs.existsSync(envPath)) process.exit(0); const source = ['apps/web/client/.env.local', 'apps/web/client/.env.example'].find(f => fs.existsSync(f)); if (!source) { console.error('Missing env file. Create apps/web/client/.env manually.'); process.exit(1); } fs.copyFileSync(source, envPath); console.log('Created ' + envPath + ' from ' + source)"

docker-check:
	@command -v docker >/dev/null 2>&1 || { echo "Docker CLI not found."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }

backend-start: ensure-env docker-check
	@cd apps/backend && bun run start 2>&1

backend-stop:
	@cd apps/backend && bun run stop 2>&1 || true

db-push: ensure-env
	@set -a; source "$(ENV_FILE)"; set +a; \
	cd packages/db && bun db:push

start-local: ensure-env docker-check backend-start db-push
	@bun run dev

stop-local:
	@lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
	@$(MAKE) backend-stop

start-local-sqlite: ensure-env
	@bun -e "Bun.spawnSync(['bun', 'run', 'dev'], { env: { ...Bun.env, ONLOOK_LOCAL_MODE: 'true', NEXT_PUBLIC_ONLOOK_LOCAL_MODE: 'true', SKIP_ENV_VALIDATION: 'true' }, stdio: ['inherit', 'inherit', 'inherit'] })"

local-db-reset:
	@bun -e "const fs = require('node:fs'); fs.rmSync('apps/web/client/onlook-local.db', { force: true }); console.log('SQLite database deleted. It will be re-created on next start.')"
