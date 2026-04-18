SHELL := /bin/zsh

ENV_FILE := apps/web/client/.env
ENV_LOCAL_FILE := apps/web/client/.env.local
ENV_EXAMPLE_FILE := apps/web/client/.env.example

.PHONY: help ensure-env db-check port-check docker-check init-docker docker-up build-app run-app run-dev start-local start-docker

help:
	@echo "Available targets:"
	@echo "  make db-check     # Verify Postgres is reachable via SUPABASE_DATABASE_URL"
	@echo "  make port-check   # Ensure port 3000 is free for web preview"
	@echo "  make init-docker  # Ensure env file and validate Docker daemon"
	@echo "  make docker-up    # Start dockerized web client"
	@echo "  make start-docker # Alias for docker-up"
	@echo "  make build-app    # Build the web app"
	@echo "  make run-app      # Start the production web app"
	@echo "  make run-dev      # Start the local dev web app"
	@echo "  make start-local  # Ensure env + Postgres, then run local dev app"

ensure-env:
	@if [ ! -f "$(ENV_FILE)" ]; then \
		if [ -f "$(ENV_LOCAL_FILE)" ]; then \
			cp "$(ENV_LOCAL_FILE)" "$(ENV_FILE)"; \
			echo "Created $(ENV_FILE) from $(ENV_LOCAL_FILE)"; \
		elif [ -f "$(ENV_EXAMPLE_FILE)" ]; then \
			cp "$(ENV_EXAMPLE_FILE)" "$(ENV_FILE)"; \
			echo "Created $(ENV_FILE) from $(ENV_EXAMPLE_FILE)"; \
		else \
			echo "Missing env source file. Create $(ENV_FILE) manually."; \
			exit 1; \
		fi; \
	fi


db-check: ensure-env
	@set -a; source "$(ENV_FILE)"; set +a; \
	bun -e "import postgres from 'postgres'; const url = process.env.SUPABASE_DATABASE_URL; if (!url) { console.error('SUPABASE_DATABASE_URL is missing in $(ENV_FILE).'); console.error('Set it to a reachable Postgres instance, then retry: make start-local'); process.exit(1); } const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 5 }); try { await sql.unsafe('select 1'); console.log('Postgres is reachable.'); } catch (error) { console.error('Could not reach Postgres using SUPABASE_DATABASE_URL.'); console.error(error); console.error('Next steps:'); console.error('  1) Start local backend DB stack: bun run backend:start'); console.error('  2) Retry app startup: make start-local'); console.error('  3) Or point SUPABASE_DATABASE_URL in $(ENV_FILE) to another running Postgres instance'); process.exit(1); } finally { await sql.end({ timeout: 1 }); }"

port-check:
	@pid=$$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -n 1); \
	if [ -n "$$pid" ]; then \
		echo "Port 3000 is already in use by PID $$pid."; \
		echo "Stop that process first so preview URLs map correctly:"; \
		echo "  kill $$pid"; \
		exit 1; \
	fi


docker-check:
	@command -v docker >/dev/null 2>&1 || { echo "Docker CLI not found."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }

init-docker: ensure-env docker-check
	@echo "Docker is ready."

docker-up: init-docker
	@docker compose up -d --build

build-app:
	@bun run build

run-app:
	@bun run start

run-dev:
	@bun run dev

start-local: db-check port-check run-dev

start-docker: docker-up

