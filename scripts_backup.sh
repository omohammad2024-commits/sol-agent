#!/usr/bin/env bash
# Daily SQLite backup. Cron example:  0 4 * * * /path/to/sol-agent/scripts_backup.sh
set -euo pipefail
DATA_DIR="${DATA_DIR:-./data}"
OUT="${BACKUP_DIR:-$DATA_DIR/backups}"
mkdir -p "$OUT"
sqlite3 "$DATA_DIR/sol.db" ".backup '$OUT/sol-$(date +%F).db'"
find "$OUT" -name 'sol-*.db' -mtime +14 -delete
