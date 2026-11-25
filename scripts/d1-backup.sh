#!/usr/bin/env bash
# Exports a D1 database (full schema + data, as SQL) and uploads it, gzipped,
# to a PRIVATE R2 bucket as  <db>/daily/<UTC timestamp>.sql.gz  — and on the 1st of
# each month (UTC) also as  <db>/monthly/<YYYY-MM>.sql.gz
# The daily copies are meant to expire: a lifecycle rule on the bucket deletes them after 35 days
# (docs/operations.md, "Backups"). The monthly ones have no rule and are kept.
# Run nightly by .github/workflows/d1-backup.yml, or by hand: npm run db:backup:now
#
# Needs CLOUDFLARE_ACCOUNT_ID and credentials (CLOUDFLARE_API_TOKEN in CI; your
# `wrangler login` locally) with D1 read + R2 write. The export contains
# customer names, emails and addresses: the bucket must never be made public.
# D1's own point-in-time restore only reaches back a limited time (how far depends on
# the plan); tax records need years, so these files are the long-term history.
set -euo pipefail
DB="${1:-opendecodesk-db}"
BUCKET="${BACKUP_BUCKET:-opendecodesk-db-backups}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID to your Cloudflare account id}"
export CLOUDFLARE_ACCOUNT_ID
# Pinned to an exact version: this runs with a Cloudflare token that can edit
# D1 and R2, so it must never pick up a new release unreviewed.
WRANGLER="${WRANGLER:-npx --yes wrangler@4.110.0}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/$DB-$STAMP.sql"

$WRANGLER d1 export "$DB" --remote --output "$OUT" </dev/null

# Refuse to upload something that obviously isn't a full backup.
grep -q "CREATE TABLE" "$OUT" || { echo "Export has no CREATE TABLE statements — refusing to upload." >&2; exit 1; }
grep -q "INSERT INTO" "$OUT"  || { echo "Export has no data — refusing to upload." >&2; exit 1; }

gzip -9 "$OUT"
put() {
  $WRANGLER r2 object put "$BUCKET/$1" --file "$OUT.gz" --remote \
    --content-type application/gzip </dev/null
  echo "Backed up $DB → r2://$BUCKET/$1 ($(wc -c < "$OUT.gz" | tr -d ' ') bytes)"
}
put "$DB/daily/$STAMP.sql.gz"
# On the 1st of the month (read from the daily file's own timestamp, so the two always agree),
# the month's copy too, which no lifecycle rule touches.
if [ "${STAMP:8:2}" = "01" ]; then
  put "$DB/monthly/${STAMP:0:7}.sql.gz"
fi
