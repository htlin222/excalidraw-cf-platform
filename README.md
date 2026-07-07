# excalidraw-cf-platform

> A self-hosted, collaborative Excalidraw platform that runs **entirely on Cloudflare's
> edge** — no servers, no containers, no ops.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Excalidraw](https://img.shields.io/badge/Excalidraw-npm-6965db?logo=excalidraw&logoColor=white)](https://www.npmjs.com/package/@excalidraw/excalidraw)

---

## What is this?

`excalidraw-cf-platform` is a production-ready scaffold for hosting your own
[Excalidraw](https://excalidraw.com/) installation with:

- **Real-time multiplayer** — one Durable Object per room, WebSocket fan-out, no
  external pub/sub.
- **Persistent scenes** — SQLite inside the Durable Object; scenes survive Worker
  restarts.
- **Document management** — create, list, rename, delete, and share diagrams via the
  REST API (D1).
- **File storage** — images and large exports go to R2.
- **Session management** — fast KV-backed sessions.
- **AI on the canvas** — Workers AI (`@cf/meta/llama-3-8b-instruct`) turns text prompts
  into Excalidraw JSON.
- **Zero-trust auth** — Cloudflare Access JWT validation guards every route; a
  `DEV_AUTH_BYPASS` flag makes local development painless.

Everything runs through **a single Worker** — the React frontend is bundled into
`frontend/dist` and served as static assets by the same Worker.

---

## Architecture

```
Browser
  │
  ├── HTTP  ──► Worker (src/index.ts)
  │                │
  │                ├── /api/documents  ──► D1  (control plane)
  │                ├── /api/share      ──► D1  (share links)
  │                ├── /api/ai         ──► Workers AI
  │                ├── /api/r2/*       ──► R2  (blobs)
  │                └── static assets  ◄── frontend/dist (Vite + React)
  │
  └── WS   ──► Durable Object: RoomDurableObject (src/room.ts)
                   │
                   └── SQLite (scene store, per-room)
```

Auth layer: every request passes through `src/auth.ts`, which validates the
Cloudflare Access JWT (`CF-Access-Jwt-Assertion` header). Locally, set
`DEV_AUTH_BYPASS=1` in `.dev.vars` to skip this.

Full details → [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## Cloudflare services used

| Service | Purpose |
|---|---|
| Workers | Request routing, REST API, static asset serving |
| Durable Objects (SQLite) | Per-room real-time state + WebSocket hub |
| D1 | Control-plane DB — accounts, documents, shares |
| KV | Sessions, feature flags |
| R2 | Image & export blob storage |
| Workers AI | Text → Excalidraw JSON |
| Cloudflare Access | Zero-trust SSO (JWT validation) |

---

## Quickstart

### Prerequisites

- Node.js ≥ 18
- A Cloudflare account (free tier works for dev)
- `npx wrangler login` — authenticate once

### 1. Install

```bash
npm install
npm --prefix frontend install
```

### 2. Provision cloud resources

```bash
bash scripts/provision.sh
```

This creates the D1 database, KV namespace, and R2 bucket, then prints the IDs.
Paste them into `wrangler.jsonc` under the matching bindings.

### 3. Apply the database schema

```bash
npx wrangler d1 execute excalidraw-platform --remote --file=./schema.sql
```

### 4. Local development

```bash
cp .dev.vars.example .dev.vars   # enables DEV_AUTH_BYPASS=1
bash scripts/dev.sh
```

Opens at `http://localhost:5173` (Vite) proxying to `wrangler dev`.

### 5. Deploy to production

```bash
bash scripts/deploy.sh
```

Runs `frontend:build` then `wrangler deploy`. Your worker goes live on the
custom domain set in `wrangler.jsonc`.

---

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` for local dev — it is gitignored.

| Variable | Where | Purpose |
|---|---|---|
| `DEV_AUTH_BYPASS` | `.dev.vars` only | Set to `1` to skip Access JWT check locally |
| `ACCESS_TEAM_DOMAIN` | `wrangler secret put` | Your Access team domain |
| `ACCESS_AUD` | `wrangler secret put` | Access application audience tag |
| `ENVIRONMENT` | `wrangler.jsonc` vars | `"production"` or `"development"` |

---

## Project layout

```
.
├── src/
│   ├── index.ts          # Worker entrypoint — routing + auth
│   ├── room.ts           # RoomDurableObject — WebSocket hub + SQLite scene store
│   ├── auth.ts           # Cloudflare Access JWT validation
│   ├── reconcile.ts      # Scene delta reconciliation helpers
│   ├── types.ts          # Shared TypeScript types
│   └── api/
│       ├── documents.ts  # CRUD for user documents (D1)
│       ├── share.ts      # Share-link generation/resolution (D1)
│       └── ai.ts         # Workers AI text-to-diagram endpoint
├── frontend/
│   └── src/
│       ├── App.tsx        # Top-level React app (auth, routing, document list)
│       ├── Editor.tsx     # Excalidraw wrapper with collab hooks
│       └── collab/
│           └── RoomClient.ts  # WebSocket client for Durable Object collab
├── scripts/
│   ├── provision.sh      # One-time resource creation (D1, KV, R2)
│   ├── dev.sh            # Parallel Vite + wrangler dev
│   └── deploy.sh         # Build frontend then deploy Worker
├── schema.sql            # D1 schema
├── wrangler.jsonc        # Wrangler config (bindings, routes, migrations)
├── ARCHITECTURE.md       # Deep-dive architecture doc
├── PLAN.md               # Phased roadmap
└── CLAUDE.md             # Agent build/deploy brief
```

---

## Roadmap

See [`PLAN.md`](./PLAN.md) for the full phased roadmap. Short-term priorities:

- [ ] End-to-end encryption option (blind relay mode)
- [ ] Room access control (invite links, ACL)
- [ ] Export to PNG/SVG via Worker
- [ ] Webhooks on scene save

---

## Not end-to-end encrypted (by design)

The Durable Object stores and processes plaintext scene data. This is intentional:
it enables persistence, search, and AI features. Transport is TLS. If you need
a blind relay (the server never sees scene content), see the notes in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repo and create a feature branch: `git checkout -b feat/your-feature`
2. **Install** dependencies: `npm install && npm --prefix frontend install`
3. **Dev loop**: `cp .dev.vars.example .dev.vars && bash scripts/dev.sh`
4. **Typecheck** before committing: `npm run typecheck`
5. Open a **pull request** — describe what you changed and why.

Please keep PRs focused. Large refactors should start as an issue/discussion first.

---

## License

MIT © 2024. See [LICENSE](LICENSE) for details.

Excalidraw itself is MIT-licensed. Its name and logo are trademarks of Excalidraw, Inc.
— rebrand before any commercial use.
