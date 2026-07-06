# PLAN.md — roadmap

A staged plan from empty account to production. Phases 1–4 are the MVP; 5–7 are the
platform layer; 8+ are hardening and scale. Each milestone has an observable "done".

## Milestone 0 — foundations (this scaffold)
- [x] Repo structure, wrangler config, docs, CLAUDE.md
- [x] Durable Object collab core with SQLite scene
- [x] Auth gate (Cloudflare Access) + dev bypass
- [x] Frontend shell embedding `@excalidraw/excalidraw`
- **Done when:** `wrangler dev` runs and two tabs sync a drawing.

## Milestone 1 — deploy the MVP
- [ ] Provision D1 / KV / R2, wire IDs
- [ ] Apply schema, deploy Worker + assets
- [ ] Cloudflare Access app in front, real IdP (Google/GitHub/Okta)
- **Done when:** live URL, gated by SSO, two users collaborate.

## Milestone 2 — persistence & documents
- [ ] `documents` CRUD backed by D1 (create → returns room id)
- [ ] Home screen: list my documents, create, open, rename, delete
- [ ] Periodic scene snapshot from the DO to R2 (version history)
- [ ] Restore-from-snapshot path
- **Done when:** a drawing survives closing every tab and reopening later.

## Milestone 3 — assets & exports
- [ ] Image paste/upload → R2 (presigned PUT), reference by key in the scene
- [ ] Server-side PNG/SVG export endpoint → R2, shareable link
- **Done when:** an embedded image reloads for a second user, exports download.

## Milestone 4 — AI on the canvas
- [ ] `/api/ai/diagram` (Workers AI → Mermaid) wired to a toolbar button
- [ ] Client converts Mermaid → Excalidraw elements and inserts them
- [ ] Optional: "clean up this sketch" / "describe this diagram" endpoints
- **Done when:** typing a prompt drops a real diagram onto the board.

## Milestone 5 — sharing & permissions
- [ ] `shares` table: per-document roles (owner / editor / viewer)
- [ ] Share links with role + expiry; viewer mode is read-only in the DO
- [ ] Enforce role at the WebSocket upgrade (viewers can't send `update`)
- **Done when:** a viewer link can watch but not edit; an editor link can edit.

## Milestone 6 — workspaces / multi-tenant
- [ ] `workspaces` + membership in D1
- [ ] Route documents and rooms by workspace; isolate listing and access
- **Done when:** two workspaces can't see each other's documents.

## Milestone 7 — presence & polish
- [ ] Live cursors + name/color, follow-mode, selection highlights
- [ ] Connection status, reconnect with backoff, offline queue
- [ ] Rate limits per user at the Worker; abuse guards on AI endpoint
- **Done when:** it feels like a product, not a demo.

## Milestone 8 — hardening & scale
- [ ] Batch/coalesce pointer traffic (already throttled; measure under load)
- [ ] Snapshot compaction; cap element churn in a single DO
- [ ] Observability: Workers logs/analytics, DO alarms for housekeeping
- [ ] Backups: scheduled D1 export + R2 lifecycle rules
- **Done when:** a room with 50 concurrent editors stays responsive and costs are known.

## Sequencing notes
- Milestones 1–4 are independent enough to parallelize after 1.
- Do 5 (permissions) before opening the platform beyond a trusted group.
- Keep `reconcile.ts` identical on client and server whenever you touch the protocol.
