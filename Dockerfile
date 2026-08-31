# ── 1. Сборка фронтенда ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── 2. Сборка сервера ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS server
WORKDIR /build
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ── 3. Рабочий образ ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOME=/home/app

# imagemagick — HEIC/TIFF в JPEG и превью; poppler — текст и первая страница PDF.
RUN apt-get update && apt-get install -y --no-install-recommends \
      imagemagick \
      poppler-utils \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# ImageMagick по умолчанию запрещает читать PDF (CVE-2016-3714). Нам нужно
# читать локальные PDF, но не сеть — снимаем запрет только на PDF.
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
      sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read" pattern="PDF" />|' /etc/ImageMagick-6/policy.xml; \
    fi

WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

COPY --from=server /build/dist ./dist
COPY --from=web    /build/dist ./web

# Каталоги данных создаются в образе и отдаются пользователю app: именованный
# том при первом подключении наследует владельца отсюда. Без этого Docker на
# Linux создал бы точку монтирования от root, и приложение не смогло бы писать.
RUN useradd -m -u 10001 app \
 && mkdir -p /data/blobs /data/tessdata \
 && chown -R app:app /app /data /home/app \
 && chmod 700 /data/blobs
USER app

EXPOSE 8433
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
