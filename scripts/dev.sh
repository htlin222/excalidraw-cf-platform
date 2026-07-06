#!/usr/bin/env bash
# Local development. Builds the frontend once, then runs the Worker with local
# bindings (local D1/KV/R2 + a local Durable Object). Re-run after frontend changes,
# or run `npm --prefix frontend run dev` in a second terminal for HMR against the
# deployed-style API.
set -euo pipefail

if [ ! -f .dev.vars ]; then
  echo "==> No .dev.vars found; creating one from .dev.vars.example (DEV_AUTH_BYPASS=1)"
  cp .dev.vars.example .dev.vars
fi

echo "==> Building frontend"
npm --prefix frontend run build

echo "==> Applying schema to LOCAL D1"
npx wrangler d1 execute excalidraw-platform --local --file=./schema.sql || true

echo "==> Starting wrangler dev"
exec npx wrangler dev
