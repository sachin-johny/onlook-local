SHELL := /bin/zsh

ENV_FILE := apps/web/client/.env
ENV_LOCAL_FILE := apps/web/client/.env.local
ENV_EXAMPLE_FILE := apps/web/client/.env.example

.PHONY: help ensure-env docker-check init-docker build-app run-app local-up

help:
	@echo "Available targets:"
	@echo "  make init-docker  # Ensure env file and start docker services"
	@echo "  make build-app    # Build the web app"
	@echo "  make run-app      # Start the web app"
	@echo "  make local-up     # Init docker, build, then run app"

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


docker-check:
	@command -v docker >/dev/null 2>&1 || { echo "Docker CLI not found."; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }

init-docker: ensure-env docker-check
	@bun run docker:up

build-app:
	@bun run build

run-app:
	@bun run start

local-up: init-docker build-app run-app
