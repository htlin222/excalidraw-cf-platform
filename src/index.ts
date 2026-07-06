import type { Env, PresenceUser } from "./types";
import { authenticate, upsertUser } from "./auth";
import { handleDocuments } from "./api/documents";
import { handleAi } from "./api/ai";

// The Durable Object class must be exported from the Worker's entry module.
export { RoomDurableObject } from "./room";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- WebSocket: /ws/:roomId ---
    const wsMatch = path.match(/^\/ws\/([A-Za-z0-9-]+)$/);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const user = await authenticate(request, env);
      if (!user) return new Response("Unauthorized", { status: 401 });

      // (Milestone 5) enforce per-document role here before routing viewers, etc.
      const roomId = wsMatch[1]!;
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));

      // Pass identity to the DO via query params; it attaches them for presence.
      const doUrl = new URL(request.url);
      doUrl.searchParams.set("uid", user.id);
      doUrl.searchParams.set("name", user.name);
      doUrl.searchParams.set("color", colorFor(user.id));
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // --- API (JSON) ---
    if (path.startsWith("/api/")) {
      const user = await authenticate(request, env);
      if (!user) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      // Keep the users table in sync with the identity provider.
      ctx.waitUntil(upsertUser(env, user));

      if (path === "/api/me") {
        const me: PresenceUser = { id: user.id, name: user.name, color: colorFor(user.id) };
        return new Response(JSON.stringify({ ...me, email: user.email }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path.startsWith("/api/documents")) return handleDocuments(request, env, user, path);
      if (path.startsWith("/api/ai/")) return handleAi(request, env, path);

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // --- Static assets (the built React app) with SPA fallback ---
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status === 404 && wantsHtml(request)) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
    }
    return assetRes;
  },
} satisfies ExportedHandler<Env>;

/** Deterministic per-user color so a user looks the same across sessions. */
function colorFor(id: string): string {
  const palette = ["#4a47b1", "#0f6e56", "#993c1d", "#993556", "#185fa5", "#854f0b"];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}

function wantsHtml(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");
}
