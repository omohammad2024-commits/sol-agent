FROM oven/bun:1-debian
# Set --build-arg WITH_CHROMIUM=true to enable `browse` (JS-rendered pages) and Persian PDF export.
ARG WITH_CHROMIUM=false
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl fonts-dejavu-core fonts-noto-core \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$WITH_CHROMIUM" = "true" ]; then bun add playwright && bunx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright; fi
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD curl -fs http://127.0.0.1:${PORT:-8080}/health || exit 1
CMD ["bun", "run", "src/index.ts"]
