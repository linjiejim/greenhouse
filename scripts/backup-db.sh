#!/usr/bin/env bash
#
# Greenhouse — verified PostgreSQL backup (manual and cron share this script).
#
# Usage:
#   ./scripts/backup-db.sh                  # dump to data/db/backups/ (local default)
#   ./scripts/backup-db.sh /path/to/dir     # dump to a directory of your choice
#
# The target database comes from the environment; the defaults match the local
# dev container. A deployment sets its own container / user / database:
#   PG_CONTAINER=greenhouse-postgres-1 ./scripts/backup-db.sh /srv/backups   # docker compose stack
#   PG_CONTAINER=my-pg PG_DB=my_db PG_USER=me BACKUP_PREFIX=mydb ./scripts/backup-db.sh /srv/backups
#
# Retention: the newest KEEP_DAILY dumps plus KEEP_WEEKLY Sunday dumps (daily
# files roll fast; the weekly ones leave room to notice "it broke last week").
#
# Restore:
#   gunzip -c greenhouse_YYYYmmdd_HHMMSS.sql.gz | docker exec -i $PG_CONTAINER psql -U $PG_USER -d $PG_DB
#
# ⚠️ A backup must be VERIFIED, not just exit 0 from pg_dump. A deployment once
#    ran for weeks writing 20-byte empty dumps (docker exec failed, the file was
#    already created, nobody looked) — a backup file that exists but is empty is
#    worse than none, because it looks like a way back. So every dump is checked
#    three ways: gzip integrity, a size floor, and pg_dump's own completion
#    marker at the tail. Any failure removes the bad file and exits non-zero so
#    cron's log / mail shows it.

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-greenhouse-pg}"
PG_USER="${PG_USER:-greenhouse}"
PG_DB="${PG_DB:-greenhouse}"
# File name prefix; retention only ever touches files this script named.
BACKUP_PREFIX="${BACKUP_PREFIX:-greenhouse}"
DATABASE_URL="${DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:5432/${PG_DB}}"
BACKUP_DIR="${1:-./data/db/backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
# The size floor only catches empty / garbage files — it is NOT a statement of
# how big the database should be. A fresh schema-only database compresses to a
# few tens of KB, so a high floor would delete legitimate backups. Real
# integrity comes from the two structural checks, which are size-independent.
MIN_BYTES="${MIN_BYTES:-10000}"

[[ "$BACKUP_PREFIX" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "❌ BACKUP_PREFIX may only contain [A-Za-z0-9_-]"; exit 2; }

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FINAL="${BACKUP_DIR}/${BACKUP_PREFIX}_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "📦 Backing up ${PG_DB} → ${FINAL}"

# pg_dump inside the container first (its version always matches the server);
# fall back to a host pg_dump against DATABASE_URL.
if docker exec "$PG_CONTAINER" pg_dump --version > /dev/null 2>&1; then
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" --no-owner --no-acl "$PG_DB" | gzip > "$FINAL"
elif command -v pg_dump > /dev/null 2>&1; then
  pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$FINAL"
else
  echo "❌ pg_dump not found (no ${PG_CONTAINER} container, no host pg_dump)."
  rm -f "$FINAL"
  exit 1
fi

# ── Verify: a file that fails any of these is not a backup ──────────────
fail() {
  echo "❌ backup verification failed: $1"
  echo "   removing the bad file so it can never be mistaken for a restore point"
  rm -f "$FINAL"
  exit 1
}

[ -f "$FINAL" ] || fail "no output file"

SIZE_BYTES=$(wc -c < "$FINAL" | tr -d ' ')
[ "$SIZE_BYTES" -ge "$MIN_BYTES" ] || fail "only ${SIZE_BYTES} bytes (< ${MIN_BYTES})"

gzip -t "$FINAL" 2>/dev/null || fail "gzip integrity check failed (truncated?)"

# pg_dump writes this line only when it finished cleanly; a truncated dump lacks it.
gunzip -c "$FINAL" | tail -5 | grep -q "PostgreSQL database dump complete" \
  || fail "missing pg_dump completion marker (truncated dump)"

SIZE=$(du -h "$FINAL" | cut -f1)
echo "✅ Backup verified: $FINAL ($SIZE)"

# ── Rotate: newest KEEP_DAILY + KEEP_WEEKLY Sunday dumps ────────────────
#
# ⚠️ Only files THIS script named (<prefix>_YYYYmmdd_HHMMSS.sql.gz) are rotated.
#    A glob like `<prefix>_*.sql.gz` looks equivalent but would also eat the
#    hand-made archives people keep next to the scheduled ones (pre-upgrade
#    dumps, old-database exports) once KEEP_DAILY newer files exist.
cd "$BACKUP_DIR"
mine() { ls -t 2>/dev/null | grep -E "^${BACKUP_PREFIX}_[0-9]{8}_[0-9]{6}\.sql\.gz$" || true; }

keep_list=$(mktemp)
mine | head -n "$KEEP_DAILY" >> "$keep_list"
# Sunday dumps get their own budget; the date in the file name is the sort key.
weekly=0
for f in $(mine); do
  day=$(echo "$f" | sed -E "s/^${BACKUP_PREFIX}_([0-9]{8})_.*/\1/")
  # GNU date (Linux) or BSD date (macOS)
  dow=$(date -d "$day" +%u 2>/dev/null || date -j -f "%Y%m%d" "$day" +%u 2>/dev/null || echo "")
  if [ "$dow" = "7" ] && [ "$weekly" -lt "$KEEP_WEEKLY" ]; then
    echo "$f" >> "$keep_list"
    weekly=$((weekly + 1))
  fi
done
sort -u "$keep_list" > "${keep_list}.final"

removed=0
for f in $(mine); do
  grep -qx "$f" "${keep_list}.final" || { rm -f "$f"; removed=$((removed + 1)); }
done
rm -f "$keep_list" "${keep_list}.final"

echo "🧹 Kept $(mine | wc -l | tr -d ' ') scheduled backups (removed ${removed}; hand-made archives untouched)"
