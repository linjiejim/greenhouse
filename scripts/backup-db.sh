#!/bin/bash
#
# Greenhouse — PostgreSQL 手动备份脚本
#
# 用法:
#   ./scripts/backup-db.sh                  # 备份到 data/db/backups/
#   ./scripts/backup-db.sh /path/to/dir     # 备份到指定目录
#
# 恢复:
#   psql $DATABASE_URL < backup_file.sql
#   # 或
#   docker exec -i greenhouse-pg psql -U greenhouse greenhouse < backup_file.sql
#

set -e

DATABASE_URL="${DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:5432/greenhouse}"
BACKUP_DIR="${1:-./data/db/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/greenhouse_${TIMESTAMP}.sql"

mkdir -p "$BACKUP_DIR"

echo "📦 Backing up PostgreSQL database..."
echo "   Target: $BACKUP_FILE"

# Use pg_dump via docker if available, otherwise direct
if docker exec greenhouse-pg pg_dump --version > /dev/null 2>&1; then
  docker exec greenhouse-pg pg_dump -U greenhouse --no-owner --no-acl greenhouse > "$BACKUP_FILE"
elif command -v pg_dump > /dev/null 2>&1; then
  pg_dump "$DATABASE_URL" --no-owner --no-acl > "$BACKUP_FILE"
else
  echo "❌ pg_dump not found. Install postgresql-client or use Docker."
  exit 1
fi

# Compress
gzip "$BACKUP_FILE"
FINAL="${BACKUP_FILE}.gz"

SIZE=$(du -h "$FINAL" | cut -f1)
echo "✅ Backup complete: $FINAL ($SIZE)"

# Clean up old backups (keep last 10)
cd "$BACKUP_DIR"
ls -t greenhouse_*.sql.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
echo "🧹 Kept latest 10 backups"
