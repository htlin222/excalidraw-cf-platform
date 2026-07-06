#!/usr/bin/env bash
# Create the Cloudflare resources this project needs, then print the IDs to paste
# into wrangler.jsonc. Re-running is safe: existing resources just report "already
# exists" and you reuse the current IDs.
set -euo pipefail

WRANGLER="npx wrangler"
D1_NAME="excalidraw-platform"
KV_BINDING="SESSIONS"
R2_BUCKET="excalidraw-platform-assets"

echo "==> Checking wrangler auth"
$WRANGLER whoami >/dev/null || { echo "Run 'npx wrangler login' first."; exit 1; }

echo
echo "==> Creating D1 database '$D1_NAME'"
$WRANGLER d1 create "$D1_NAME" || echo "   (may already exist — that's fine)"

echo
echo "==> Creating KV namespace '$KV_BINDING'"
$WRANGLER kv namespace create "$KV_BINDING" || echo "   (may already exist — that's fine)"

echo
echo "==> Creating R2 bucket '$R2_BUCKET'"
$WRANGLER r2 bucket create "$R2_BUCKET" || echo "   (may already exist — that's fine)"

cat <<'NEXT'

------------------------------------------------------------------------
Next steps:
  1. Copy the D1 "database_id" printed above into wrangler.jsonc
     (d1_databases[0].database_id).
  2. Copy the KV namespace "id" printed above into wrangler.jsonc
     (kv_namespaces[0].id).
  3. The R2 bucket is referenced by name — nothing to paste.
  4. Apply the schema:
       npx wrangler d1 execute excalidraw-platform --remote --file=./schema.sql
------------------------------------------------------------------------
NEXT
