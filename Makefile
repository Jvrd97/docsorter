.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose
PORT := $(shell sed -n 's/^[[:space:]]*APP_PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' .env 2>/dev/null | head -1)
ifeq ($(strip $(PORT)),)
PORT := 8433
endif

.PHONY: help deploy up down restart rebuild logs ps health user totp backup import clean serve unserve

help: ## Показать список команд
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

check-env:
	@test -f .env || { \
		echo "Нет .env. Сделай: cp .env.example .env"; \
		echo "и впиши два секрета:"; \
		echo "  openssl rand -base64 32   # POSTGRES_PASSWORD"; \
		echo "  openssl rand -hex 48      # SESSION_SECRET"; \
		exit 1; }

deploy: check-env ## Забрать с GitHub, пересобрать, поднять
	@echo "── забираю изменения ──"
	@git pull --ff-only
	@echo "── пересобираю и поднимаю ──"
	@$(COMPOSE) up -d --build
	@$(MAKE) --no-print-directory health

up: check-env ## Поднять без пересборки
	@$(COMPOSE) up -d
	@$(MAKE) --no-print-directory health

down: ## Остановить (данные остаются)
	@$(COMPOSE) down

restart: ## Перезапустить приложение
	@$(COMPOSE) restart app
	@$(MAKE) --no-print-directory health

rebuild: check-env ## Пересобрать образ с нуля, без кэша
	@$(COMPOSE) build --no-cache
	@$(COMPOSE) up -d
	@$(MAKE) --no-print-directory health

health: ## Дождаться готовности и показать статус
	@echo "── жду приложение на порту $(PORT) ──"
	@for i in $$(seq 1 60); do \
		if curl -fsS -m 2 "http://localhost:$(PORT)/api/health" >/dev/null 2>&1; then \
			echo "готово: $$(curl -fsS "http://localhost:$(PORT)/api/health")"; \
			echo "открывай: http://localhost:$(PORT)"; \
			exit 0; \
		fi; sleep 2; \
	done; \
	echo "не поднялось за 2 минуты. Смотри: make logs"; \
	$(COMPOSE) ps; exit 1

serve: ## Открыть по HTTPS внутри своей сети Tailscale
	@command -v tailscale >/dev/null || { echo "tailscale не установлен"; exit 1; }
	@sudo tailscale serve --bg $(PORT)
	@echo
	@tailscale serve status
	@echo "Адрес: https://$$(tailscale status --json | sed -n 's/.*\"DNSName\":\"\([^\"]*\)\.\".*/\1/p' | head -1)"

unserve: ## Закрыть раздачу через Tailscale
	@sudo tailscale serve --https=443 off
	@echo "раздача выключена"

logs: ## Живой лог приложения
	@$(COMPOSE) logs -f --tail=100 app

ps: ## Что запущено
	@$(COMPOSE) ps

user: ## Завести пользователя
	@$(COMPOSE) exec app node dist/scripts/create-user.js

totp: ## Включить второй фактор
	@$(COMPOSE) exec app node dist/scripts/setup-totp.js

backup: ## Бэкап базы и файлов в ./backups
	@mkdir -p backups
	@stamp=$$(date +%Y-%m-%d-%H%M); \
	$(COMPOSE) exec -T db pg_dump -U docsorter docsorter | gzip > "backups/db-$$stamp.sql.gz"; \
	tar czf "backups/blobs-$$stamp.tar.gz" -C data blobs 2>/dev/null || true; \
	echo "готово:"; ls -lh backups/*$$stamp*
	@echo "Пароль храни отдельно: без него blobs не расшифровать."

import: ## Перенести старый архив: make import FROM=~/путь LOGIN=имя
	@test -n "$(FROM)" || { echo "укажи FROM=~/Documents/MyVault/Life/Dokumente"; exit 1; }
	@test -n "$(LOGIN)" || { echo "укажи LOGIN=свой-логин"; exit 1; }
	@node tools/import-vault.mjs --url "http://localhost:$(PORT)" --login "$(LOGIN)" --from "$(FROM)"

clean: ## Снести контейнеры И ВСЕ ДАННЫЕ
	@echo "Это удалит базу и все загруженные документы."
	@read -p "Напиши УДАЛИТЬ, если уверен: " ok; \
	[ "$$ok" = "УДАЛИТЬ" ] || { echo "отменено"; exit 1; }; \
	$(COMPOSE) down -v; rm -rf data
