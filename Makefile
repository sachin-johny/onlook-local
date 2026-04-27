SHELL := /bin/zsh

ENV_FILE := apps/web/client/.env
ENV_LOCAL_FILE := apps/web/client/.env.local
ENV_EXAMPLE_FILE := apps/web/client/.env.example

.PHONY: help start-local stop-local backend-start backend-stop db-push

help:
	@echo "Usage:"
	@echo "  make start-local   # Start Supabase, push schema, run dev app"
	@echo "  make stop-local    # Stop dev app, then stop Supabase"

ensure-env:
	@if [ ! -f "$(ENV_FILE)" ]; then \
		if [ -f "$(ENV_LOCAL_FILE)" ]; then \
			cp "$(ENV_LOCAL_FILE)" "$(ENV_FILE)"; \
		elif [ -f "$(ENV_EXAMPLE_FILE)" ]; then \
			cp "$(ENV_EXAMPLE_FILE)" "$(ENV_FILE)"; \
		else \
			echo "Missing env file. Create $(ENV_FILE) manually."; \
			exit 1; \
		fi; \
	fi

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
