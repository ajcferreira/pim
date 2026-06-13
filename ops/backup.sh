#!/usr/bin/env sh
# Nightly backup: Postgres dump + asset files, with retention.
# Cron example:  0 3 * * *  /app/ops/backup.sh
# REQUIRED env: DATABASE_URL, ASSET_DIR, BACKUP_DIR
# Optional: RETENTION_DAYS (default 14)
set -eu
: "${DATABASE_URL:?}" ; : "${ASSET_DIR:?}" ; : "${BACKUP_DIR:?}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

pg_dump --no-owner --format=custom "$DATABASE_URL" > "$BACKUP_DIR/db-$STAMP.dump"
tar -czf "$BACKUP_DIR/assets-$STAMP.tar.gz" -C "$ASSET_DIR" .

# Verify the dump is restorable (lists contents without restoring)
pg_restore --list "$BACKUP_DIR/db-$STAMP.dump" > /dev/null

find "$BACKUP_DIR" -name 'db-*.dump' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'assets-*.tar.gz' -mtime +"$RETENTION_DAYS" -delete
echo "backup complete: db-$STAMP.dump + assets-$STAMP.tar.gz"
# Restore: pg_restore -d "$DATABASE_URL" --clean db-<stamp>.dump
#          tar -xzf assets-<stamp>.tar.gz -C "$ASSET_DIR"
