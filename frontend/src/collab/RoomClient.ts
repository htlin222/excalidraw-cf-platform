// Browser side of the collaboration protocol. Mirrors src/room.ts on the server.
// The reconcile rule below MUST stay identical to src/reconcile.ts.

export interface SyncElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface PointerMessage {
  user: PresenceUser;
  x: number;
  y: number;
  button?: "up" | "down";
  selectedElementIds?: string[];
}

export interface RoomHandlers {
  onInit(elements: SyncElement[]): void;
  onUpdate(elements: SyncElement[]): void;
  onPointer(msg: PointerMessage): void;
  onPresence(users: PresenceUser[]): void;
}

/** Keep in sync with src/reconcile.ts::shouldReplace. */
export function shouldReplace(
  existing: { version: number; versionNonce: number } | undefined,
  incoming: { version: number; versionNonce: number }
): boolean {
  if (!existing) return true;
  if (incoming.version > existing.version) return true;
  if (incoming.version < existing.version) return false;
  return incoming.versionNonce < existing.versionNonce;
}

const POINTER_INTERVAL_MS = 50; // ~20 messages/sec — protects the single-threaded DO
const KEEPALIVE_MS = 25_000;

export class RoomClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 500;
  private keepalive?: ReturnType<typeof setInterval>;
  private lastPointerSent = 0;

  constructor(
    private roomId: string,
    private user: PresenceUser,
    private handlers: RoomHandlers,
    private shareCode?: string | null
  ) {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      uid: this.user.id,
      name: this.user.name,
      color: this.user.color,
    });
    if (this.shareCode) params.set("share", this.shareCode);
    const ws = new WebSocket(`${proto}//${location.host}/ws/${this.roomId}?${params}`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoff = 500;
      ws.send(JSON.stringify({ type: "hello" }));
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, KEEPALIVE_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (ev.data === "pong") return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "init":
          this.handlers.onInit(msg.elements ?? []);
          break;
        case "update":
          this.handlers.onUpdate(msg.elements ?? []);
          break;
        case "pointer":
          this.handlers.onPointer(msg as PointerMessage);
          break;
        case "presence":
          this.handlers.onPresence(msg.users ?? []);
          break;
      }
    });

    ws.addEventListener("close", () => {
      if (this.keepalive) clearInterval(this.keepalive);
      if (this.closed) return;
      // Reconnect with capped exponential backoff.
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    });

    ws.addEventListener("error", () => ws.close());
  }

  sendUpdate(elements: SyncElement[]): void {
    if (!elements.length) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "update", elements }));
    }
  }

  sendPointer(
    x: number,
    y: number,
    button: "up" | "down" | undefined,
    selectedElementIds: string[]
  ): void {
    const now = Date.now();
    if (now - this.lastPointerSent < POINTER_INTERVAL_MS) return;
    this.lastPointerSent = now;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: "pointer", user: this.user, x, y, button, selectedElementIds })
      );
    }
  }

  close(): void {
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.ws?.close();
  }
}
