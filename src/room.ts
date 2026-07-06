import { DurableObject } from "cloudflare:workers";
import type { Env, SyncElement, ClientMessage, ServerMessage, PresenceUser } from "./types";
import { reconcileInto } from "./reconcile";

/**
 * One instance per room/document. Coordinates the WebSockets of everyone in the room
 * and stores the authoritative scene in the object's own SQLite database.
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket) so the object can drop out
 * of memory when idle without disconnecting clients — no duration charges while quiet.
 */
export class RoomDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;
  // In-memory mirror of the scene, hydrated from SQLite. Lost on hibernation and
  // rebuilt in the constructor; SQLite is the durable source of truth.
  private elements = new Map<string, SyncElement>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS elements (
           id TEXT PRIMARY KEY,
           version INTEGER NOT NULL,
           version_nonce INTEGER NOT NULL,
           deleted INTEGER NOT NULL DEFAULT 0,
           data TEXT NOT NULL
         )`
      );
      const rows = this.sql.exec(`SELECT data FROM elements`).toArray();
      for (const row of rows) {
        try {
          const el = JSON.parse(row.data as string) as SyncElement;
          this.elements.set(el.id, el);
        } catch {
          /* skip corrupt row */
        }
      }
    });

    // Static keepalive: clients send the literal string "ping"; the runtime replies
    // "pong" without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const user: PresenceUser = {
      id: url.searchParams.get("uid") || crypto.randomUUID(),
      name: url.searchParams.get("name") || "Anonymous",
      color: url.searchParams.get("color") || randomColor(),
    };

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation-compatible accept. Attach the user so it survives eviction.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(user);

    // Send the full current scene, then announce presence to the room.
    const init: ServerMessage = { type: "init", elements: [...this.elements.values()] };
    server.send(JSON.stringify(init));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "hello": {
        const init: ServerMessage = { type: "init", elements: [...this.elements.values()] };
        ws.send(JSON.stringify(init));
        return;
      }

      case "update": {
        if (!Array.isArray(msg.elements) || msg.elements.length === 0) return;
        // Reconcile, then PERSIST before broadcasting (in-memory state is volatile).
        const accepted = reconcileInto(this.elements, msg.elements);
        if (accepted.length === 0) return;
        this.persist(accepted);
        const out: ServerMessage = { type: "update", elements: accepted };
        this.broadcast(JSON.stringify(out), ws);
        return;
      }

      case "pointer": {
        // Ephemeral: never stored, just relayed to peers. High-frequency — the client
        // throttles these to ~20/s.
        const out: ServerMessage = { type: "pointer", ...msg };
        this.broadcast(JSON.stringify(out), ws);
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence();
  }

  // --- helpers ---

  private persist(accepted: SyncElement[]): void {
    for (const el of accepted) {
      this.sql.exec(
        `INSERT INTO elements (id, version, version_nonce, deleted, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           version_nonce = excluded.version_nonce,
           deleted = excluded.deleted,
           data = excluded.data`,
        el.id,
        el.version,
        el.versionNonce,
        el.isDeleted ? 1 : 0,
        JSON.stringify(el)
      );
    }
  }

  private broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* peer gone; will be cleaned up on close */
      }
    }
  }

  private broadcastPresence(): void {
    const users: PresenceUser[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const u = ws.deserializeAttachment() as PresenceUser | null;
      if (u && !seen.has(u.id)) {
        seen.add(u.id);
        users.push(u);
      }
    }
    const msg: ServerMessage = { type: "presence", users };
    this.broadcast(JSON.stringify(msg));
  }
}

function randomColor(): string {
  const palette = ["#4a47b1", "#0f6e56", "#993c1d", "#993556", "#185fa5", "#854f0b"];
  return palette[Math.floor(Math.random() * palette.length)]!;
}
