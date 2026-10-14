#!/bin/sh
# Railway mounts volumes as root; make /data writable for the bun user before dropping privileges.
chown bun:bun /data 2>/dev/null || true
exec runuser -u bun -- bun run src/index.ts
