# excalidraw-cf-platform

A self-hosted, collaborative Excalidraw platform running entirely on Cloudflare —
Workers + Durable Objects + D1 + KV + R2 + Workers AI, with SSO via Cloudflare Access.

Real-time collaboration is powered by **one Durable Object per room** (the replacement
for `excalidraw-room`), which holds the live scene in SQLite and fans updates out to
connected clients over hibernatable WebSockets. The frontend embeds the
`@excalidraw/excalidraw` npm package inside a small React app served as static assets
by the same Worker.

> This scaffold is designed to be finished by an agent. Open the folder in
> **Claude Code** and it will read [`CLAUDE.md`](./CLAUDE.md) and take it from install
> to deployed. Everything happens through `wrangler`.

## Quickstart (manual)

```bash
# 0. one-time
npx wrangler login

# 1. install
npm install
npm --prefix frontend install

# 2. create D1 + KV + R2, then paste the printed IDs into wrangler.jsonc
bash scripts/provision.sh

# 3. schema
npx wrangler d1 execute excalidraw-platform --remote --file=./schema.sql

# 4. run locally
bash scripts/dev.sh

# 5. ship it
bash scripts/deploy.sh
```

## Docs

- [`PLAN.md`](./PLAN.md) — phased roadmap and milestones.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the pieces fit, the E2E decision, the
  data model, and the collab protocol.
- [`CLAUDE.md`](./CLAUDE.md) — the build/deploy brief the agent follows.

## Not end-to-end encrypted (on purpose)

The Durable Object sees plaintext scene data. That's what enables persistence, search,
and AI on the canvas. Transport is TLS. See ARCHITECTURE.md for the reasoning and how
to switch to a blind relay if you need E2E.

## License

MIT for this scaffold. Excalidraw itself is MIT; its name and logo are trademarks —
rebrand before commercial use.
