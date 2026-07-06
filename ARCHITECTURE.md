# ARCHITECTURE.md

## Request flow

```
Browser (your app + @excalidraw/excalidraw)
   │  HTTPS (REST)         │  WSS (collab)
   ▼                       ▼
Cloudflare Worker  ── verify ──▶  SSO (Cloudflare Access / OIDC)
   │  auth gate + routing
   ├── /ws  ─ upgrade ─▶  Durable Object  (one per room)
   │                        • hibernatable WebSockets
   │                        • live scene in SQLite
   │                        • fan-out to peers
   ├── /api/documents ─▶  D1   (accounts, docs, shares)
   ├── /api/ai/*       ─▶  Workers AI
   ├── (snapshots/img) ─▶  R2
   ├── (sessions/flags)─▶  KV
   └── everything else ─▶  static assets (frontend/dist)
```

The Worker is the only front door. It authenticates first, then either routes a REST
call, upgrades a WebSocket to the room's Durable Object, or serves a static asset.

## Why a Durable Object per room

Excalidraw's own collaboration is a Socket.IO server that relays messages between the
clients in a room and holds no central coordination state. A Cloudflare Durable Object
is exactly that primitive done natively: one addressable instance per logical unit
(here, one per room/document), single-threaded so updates serialize without races, and
able to keep WebSocket connections open. With the **WebSocket Hibernation API**, idle
rooms drop out of memory and stop accruing duration charges while clients stay
connected. Because SQLite-backed Durable Objects are generally available (10 GB each),
the same object that coordinates the sockets also *stores* the authoritative scene —
no separate database round-trip on the hot path.

`env.ROOM.idFromName(roomId)` maps a room id to a stable object, so every client in a
room lands on the same instance regardless of where they are in the world.

## The E2E decision (read this before changing room.ts)

Upstream Excalidraw is end-to-end encrypted: the room key lives in the URL fragment and
the relay only ever sees ciphertext. That's great for privacy but it means the server —
and therefore Workers AI, full-text search, and any server-side persistence — cannot
read the drawing.

This platform **deliberately does not** do E2E. The Durable Object receives plaintext
scene data. That unlocks:
- durable server-side persistence and version history,
- AI features that operate on canvas content,
- search and thumbnails,
- server-authoritative reconciliation.

Transport is still TLS end to end. If you need true E2E later, that is a different
product: `room.ts` becomes a blind relay (broadcast opaque blobs, store nothing
readable), and the AI/search/persistence features come off the table for shared rooms.
Don't flip this quietly — it changes the security model users rely on.

## Collaboration protocol

JSON messages over a single WebSocket per client. Ephemeral messages (pointers) are
never persisted; scene mutations are.

Client → Server
- `{ "type": "hello" }` — sent on connect. Server replies with the full scene.
- `{ "type": "update", "elements": ExcalidrawElement[] }` — the elements that changed
  locally (new, mutated, or flagged deleted).
- `{ "type": "pointer", "user": {id,name,color}, "x": n, "y": n, "button": "up"|"down", "selectedElementIds": string[] }`
  — ephemeral cursor/selection; throttled to ~20/s by the client.

Server → Client
- `{ "type": "init", "elements": ExcalidrawElement[] }` — full scene for a new joiner.
- `{ "type": "update", "elements": ExcalidrawElement[] }` — the elements that were
  actually accepted after reconciliation, broadcast to everyone else.
- `{ "type": "pointer", ... }` — relayed cursor from a peer.
- `{ "type": "presence", "users": [{id,name,color}] }` — who's in the room.

### Reconciliation

Every Excalidraw element carries a monotonically increasing `version` and a random
`versionNonce`. Two clients editing concurrently converge with a deterministic rule
(`src/reconcile.ts`, used identically on both ends):

> Incoming element wins over the stored one iff
> `incoming.version > stored.version`, or
> (`incoming.version === stored.version` and `incoming.versionNonce < stored.versionNonce`).

The nonce tie-breaker makes the outcome independent of message arrival order, so all
clients and the server land on the same scene. Deleted elements are kept (flagged
`isDeleted`) rather than removed, so a late "undo" from another client still reconciles.

## Storage model

- **Durable Object SQLite** — the live, authoritative scene. Table `elements(id,
  version, version_nonce, deleted, data)`; one row per element, upserted on accept.
  This is hot-path storage co-located with the sockets.
- **D1** — the control plane: `users`, `documents`, `shares`, later `workspaces`.
  Cross-room, relational, queried by the Worker for listing and access checks. See
  `schema.sql`.
- **KV** — sessions and feature flags. Eventually consistent, read-heavy; never the
  source of truth for anything you can't reconstruct.
- **R2** — large blobs: images embedded in scenes, exported PNG/SVG, and periodic scene
  snapshots for version history. KV is wrong for big or numerous blobs; R2 is right.

## Auth

Default is **Cloudflare Access** in front of the Worker: the user authenticates with
your IdP, Access injects a signed JWT (`Cf-Access-Jwt-Assertion`), and `src/auth.ts`
verifies it against the team's JWKS. No login UI to build. Best for team/internal use.

For a public multi-tenant SaaS with your own login screen, swap to **OIDC in the
Worker** (stubbed in `auth.ts`): sessions in KV, users in D1. More code; only worth it
when you need your own auth surface.

Either way, authentication happens at the Worker **before** the WebSocket upgrade is
routed to the Durable Object — the room object itself trusts that the Worker already
checked. That's also where per-role enforcement lives (a viewer's socket is refused the
`update` message type).

## Scaling notes

- A single DO is single-threaded with a ~1,000 req/s soft cap. Pointer traffic is the
  thing that gets there first, so it's throttled client-side and should be coalesced if
  you push room sizes up.
- Persist scene mutations to SQLite *before* broadcasting; in-memory state is discarded
  on hibernation, SQLite is not.
- Use a DO alarm for housekeeping (snapshot to R2, compact deleted elements) instead of
  timers, which would keep the object awake and billable.
