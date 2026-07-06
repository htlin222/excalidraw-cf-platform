# CLAUDE.md — build & deploy brief for Claude Code

You are Claude Code working inside this repo on the user's machine. Your job is to
take this scaffold to a **live, deployed, collaborative Excalidraw platform on
Cloudflare**, using `wrangler` for everything. The hard architectural decisions are
already made and encoded below — follow them, don't re-litigate them.

Prefer running real commands (`wrangler`, `npm`) over asking the user. Ask only when
you hit a genuine fork: a missing account, an ambiguous domain name, or a destructive
action. Announce each phase, run it, verify it, then move on.

---

## What this is

A self-hosted whiteboard platform. Stack:

| Concern            | Cloudflare primitive        | Where in repo                        |
|--------------------|-----------------------------|--------------------------------------|
| Realtime collab    | Durable Object (per room)   | `src/room.ts`                        |
| Live scene storage | SQLite inside the DO        | `src/room.ts`, `src/reconcile.ts`    |
| Frontend           | Static assets on the Worker | `frontend/` → built to `frontend/dist` |
| Accounts / docs    | D1                          | `schema.sql`, `src/api/documents.ts` |
| Sessions / flags   | KV                          | `src/auth.ts`                        |
| Images / exports   | R2                          | `src/api/*` (extend), `wrangler.jsonc` |
| AI diagrams        | Workers AI                  | `src/api/ai.ts`                      |
| SSO                | Cloudflare Access (default) | `src/auth.ts`                        |

## The one decision that shapes everything: NOT end-to-end encrypted

Upstream Excalidraw collab is E2E — the room server only relays ciphertext. We
**deliberately drop that** so the Durable Object sees plaintext scene data. That is
what makes server-side persistence, AI-on-canvas, and search possible. Transport is
still TLS. If the user ever asks for E2E, that's a different product and a rewrite of
`room.ts` into a blind relay — flag it, don't silently switch.

## Definition of done

1. `wrangler deploy` succeeds.
2. Opening the deployed URL in two browser windows, drawing in one, shows the change
   in the other within a second.
3. `POST /api/ai/diagram` returns Mermaid text for a prompt.
4. `GET /api/documents` returns the caller's documents from D1 (empty list is fine).
5. No secrets are committed. `.dev.vars` and `frontend/dist` stay gitignored.

---

## Ordered build plan

Work top to bottom. Each phase ends with a verification you actually run.

### Phase 0 — prerequisites
- Node 20+ (`node -v`). If missing, tell the user to install it; do not proceed.
- `npx wrangler login` (opens browser). Confirm with `npx wrangler whoami`.
- Confirm the account is on the **Workers Paid** plan if you want R2 + higher DO
  limits; the free plan works for a demo (5 GB total DO storage, SQLite-backed DOs
  are available on free).

### Phase 1 — install
```bash
npm install
npm --prefix frontend install
```

### Phase 2 — provision resources
Run the helper, which creates D1 + KV + R2 and prints the IDs:
```bash
bash scripts/provision.sh
```
Then **paste the printed IDs** into `wrangler.jsonc` (`database_id`, KV `id`). The R2
bucket is referenced by name, no ID needed. The script is idempotent-ish; if a
resource already exists it will say so — reuse the existing IDs.

If you prefer to do it by hand, the exact commands are:
```bash
npx wrangler d1 create excalidraw-platform
npx wrangler kv namespace create SESSIONS
npx wrangler r2 bucket create excalidraw-platform-assets
```

### Phase 3 — apply the database schema
```bash
npx wrangler d1 execute excalidraw-platform --remote --file=./schema.sql
```
Use `--local` first if you want to test against the local D1 during `wrangler dev`.

### Phase 4 — auth wiring (choose ONE)
Default is **Cloudflare Access** (least code):
1. In the Cloudflare dashboard → Zero Trust → Access → Applications, create a
   self-hosted app for your Worker's domain. Add an identity provider (Google,
   GitHub, Okta, one-time-PIN…).
2. Set the team domain as a var so the JWT verifier can find the JWKS:
   ```bash
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. myteam.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the Application Audience (AUD) tag
   ```
`src/auth.ts` verifies the `Cf-Access-Jwt-Assertion` header against that JWKS. No app
login UI needed — Access sits in front.

Alternative (**OIDC in the Worker**, if this is a public multi-tenant SaaS with your
own login screen): implement the OIDC code path stubbed in `src/auth.ts`, store
sessions in KV, and remove the Access checks. Only do this if the user asks — it's
more code and Access covers most cases.

For local dev without Access, `.dev.vars` sets `DEV_AUTH_BYPASS=1` and the verifier
returns a fake user. **Never** set that in production.

### Phase 5 — pick a current Workers AI model
`src/api/ai.ts` defaults to `@cf/meta/llama-3.1-8b-instruct`. Model names change —
run `npx wrangler ai models` (or check the dashboard catalog) and update the constant
if a better instruct model is available. The endpoint asks the model for Mermaid; the
frontend converts Mermaid → Excalidraw elements client-side via
`@excalidraw/mermaid-to-excalidraw`.

### Phase 6 — pin Excalidraw and build the frontend
`@excalidraw/excalidraw` moves fast and occasionally changes its collab-facing API
(`updateScene`, `setCollaborators`, element `version`/`versionNonce`). Pin the version
in `frontend/package.json`, and if a build error mentions a renamed export, check the
installed version's docs before changing `frontend/src/Editor.tsx`.
```bash
npm --prefix frontend run build   # outputs frontend/dist, which the Worker serves
```

### Phase 7 — local smoke test
```bash
bash scripts/dev.sh   # wrangler dev with local bindings
```
Open two tabs on the printed localhost URL, draw, confirm sync. Hit
`/api/ai/diagram` with a curl POST.

### Phase 8 — deploy
```bash
bash scripts/deploy.sh   # builds frontend then wrangler deploy
```
Verify against the **Definition of done** above on the live URL.

---

## File map (where to extend)

- `src/index.ts` — Worker entry. Routing, the auth gate, WebSocket upgrade → DO,
  static-asset fallback. This is the front door; new REST routes get registered here.
- `src/room.ts` — `RoomDurableObject`. Hibernatable WebSocket handling + SQLite-backed
  scene. This is the excalidraw-room replacement. Extend the message protocol here.
- `src/reconcile.ts` — the shared merge rule (Excalidraw's `version`/`versionNonce`).
  The client uses the same rule; keep them in sync.
- `src/auth.ts` — Access JWT verification + dev bypass + the OIDC stub.
- `src/api/documents.ts` — D1 CRUD. Room ids live here.
- `src/api/ai.ts` — Workers AI diagram endpoint.
- `frontend/src/Editor.tsx` — mounts `<Excalidraw>`, wires it to `RoomClient`.
- `frontend/src/collab/RoomClient.ts` — the browser WebSocket client + reconciliation.

## Gotchas that will actually bite (don't skip)

1. **Batch pointer/cursor messages.** They're the high-frequency path. A DO is
   single-threaded with a ~1,000 req/s soft cap; many tiny WS messages overwhelm one
   object. `RoomClient` already throttles pointer sends (~20/s) — keep it.
2. **Persist before you might fail.** In `room.ts`, scene mutations are written to
   SQLite before broadcasting. In-memory state is lost on hibernation; SQLite survives.
3. **Secure context required.** Excalidraw uses Web Crypto; it only works over HTTPS
   (or localhost). `wrangler dev` and `*.workers.dev` both satisfy this.
4. **`run_worker_first`.** `wrangler.jsonc` sets `assets.run_worker_first: true` so the
   Worker sees every request and delegates non-API paths to `env.ASSETS`. If your
   wrangler version rejects that key, upgrade wrangler (`npm i -D wrangler@latest`) —
   the delegation logic in `index.ts` is written to work either way.
5. **DO migrations.** The `migrations` block uses `new_sqlite_classes`. If you rename
   the class, add a new migration tag with `renamed_classes`; never edit an applied tag.
6. **Trademark.** Excalidraw is MIT (fine to use commercially) but the name/logo are
   trademarks — rebrand before selling.

## Guardrails
- Do not commit `.dev.vars`, `.env`, `node_modules`, or `frontend/dist`.
- Do not write real secrets into `wrangler.jsonc`; use `wrangler secret put`.
- Do not disable the auth gate to "make it work" — use `DEV_AUTH_BYPASS` locally only.
- If a phase's verification fails, stop and fix it before moving on. Report what broke.
