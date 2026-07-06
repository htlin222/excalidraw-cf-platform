#!/usr/bin/env bash
# Build the frontend and deploy the Worker (code + static assets + DO migration).
set -euo pipefail

echo "==> Typechecking Worker"
npx tsc --noEmit

echo "==> Building frontend -> frontend/dist"
npm --prefix frontend install
npm --prefix frontend run build

echo "==> Deploying to Cloudflare"
npx wrangler deploy

cat <<'DONE'

------------------------------------------------------------------------
Deployed. Verify:
  - Open the printed *.workers.dev URL (or your custom domain) in two tabs and draw.
  - curl -X POST <url>/api/ai/diagram -H 'content-type: application/json' \
         -d '{"prompt":"user signs up then verifies email"}'
  - Ensure a Cloudflare Access application is in front of the domain for real auth.
------------------------------------------------------------------------
DONE
