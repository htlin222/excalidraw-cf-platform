import type { Env, User } from "../types";

/**
 * Documents CRUD over D1. A document id doubles as the room id used to address the
 * Durable Object. Access is owner-or-shared; extend `canAccess` for workspace rules.
 */
export async function handleDocuments(
  request: Request,
  env: Env,
  user: User,
  path: string
): Promise<Response> {
  const method = request.method;

  // GET /api/documents -> list the caller's documents (owned or shared)
  if (path === "/api/documents" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.title, d.updated_at, d.owner_id
         FROM documents d
         LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?1
        WHERE d.owner_id = ?1 OR s.user_id = ?1
        ORDER BY d.updated_at DESC`
    )
      .bind(user.id)
      .all();
    return json({ documents: results });
  }

  // POST /api/documents -> create a document, returns its id (= room id)
  if (path === "/api/documents" && method === "POST") {
    const body = (await safeJson(request)) as { title?: string };
    const id = crypto.randomUUID();
    const title = (body.title || "Untitled").slice(0, 200);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents (id, owner_id, title) VALUES (?, ?, ?)`
      ).bind(id, user.id, title),
      env.DB.prepare(
        `INSERT INTO shares (document_id, user_id, role) VALUES (?, ?, 'owner')`
      ).bind(id, user.id),
    ]);
    return json({ id, title }, 201);
  }

  // Link sharing: /api/documents/:id/share
  const shareMatch = path.match(/^\/api\/documents\/([A-Za-z0-9-]+)\/share$/);
  if (shareMatch) {
    const docId = shareMatch[1]!;
    if (!(await canAccess(env, user, docId))) {
      return json({ error: "not found" }, 404);
    }

    if (method === "GET") {
      const share = await getShare(env, docId, request);
      return json({ share });
    }

    if (method === "PATCH") {
      if (!(await canOwnDocument(env, user, docId))) {
        return json({ error: "forbidden" }, 403);
      }

      const body = (await safeJson(request)) as { active?: boolean };
      if (typeof body.active !== "boolean") {
        return json({ error: "active boolean required" }, 400);
      }

      const share = body.active
        ? await activateShare(env, user, docId, request)
        : await deactivateShare(env, docId, request);
      return json({ share });
    }

    return json({ error: "not found" }, 404);
  }

  // Routes on a specific document: /api/documents/:id
  const match = path.match(/^\/api\/documents\/([A-Za-z0-9-]+)$/);
  if (match) {
    const docId = match[1]!;
    if (!(await canAccess(env, user, docId))) {
      return json({ error: "not found" }, 404);
    }

    if (method === "GET") {
      const row = await env.DB.prepare(
        `SELECT id, title, owner_id, updated_at FROM documents WHERE id = ?`
      )
        .bind(docId)
        .first();
      return row ? json(row) : json({ error: "not found" }, 404);
    }

    if (method === "PATCH") {
      const body = (await safeJson(request)) as { title?: string };
      if (typeof body.title === "string") {
        await env.DB.prepare(
          `UPDATE documents SET title = ?, updated_at = unixepoch() WHERE id = ?`
        )
          .bind(body.title.slice(0, 200), docId)
          .run();
      }
      return json({ ok: true });
    }

    if (method === "DELETE") {
      // Only the owner may delete.
      const owned = await env.DB.prepare(
        `SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`
      )
        .bind(docId, user.id)
        .first();
      if (!owned) return json({ error: "forbidden" }, 403);
      await env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(docId).run();
      // Note: the room's Durable Object still holds the scene in its own SQLite. To
      // reclaim it, connect to the DO and call storage.deleteAll() (add a maintenance
      // route), or let it age out — see PLAN.md Milestone 8.
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

export async function canAccess(env: Env, user: User, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM documents d
       LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?2
      WHERE d.id = ?1 AND (d.owner_id = ?2 OR s.user_id = ?2)`
  )
    .bind(docId, user.id)
    .first();
  return !!row;
}

export async function canOwnDocument(env: Env, user: User, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`)
    .bind(docId, user.id)
    .first();
  return !!row;
}

async function getShare(env: Env, docId: string, request: Request): Promise<SharePayload> {
  const row = await env.DB.prepare(
    `SELECT code, active, updated_at FROM document_links WHERE document_id = ?`
  )
    .bind(docId)
    .first<ShareRow>();
  return sharePayload(row, request);
}

async function activateShare(
  env: Env,
  user: User,
  docId: string,
  request: Request
): Promise<SharePayload> {
  const existing = await env.DB.prepare(
    `SELECT code, active, updated_at FROM document_links WHERE document_id = ?`
  )
    .bind(docId)
    .first<ShareRow>();

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO document_links (document_id, code, active, created_by)
       VALUES (?, ?, 1, ?)`
    )
      .bind(docId, randomShareCode(), user.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE document_links SET active = 1, updated_at = unixepoch() WHERE document_id = ?`
    )
      .bind(docId)
      .run();
  }

  return getShare(env, docId, request);
}

async function deactivateShare(
  env: Env,
  docId: string,
  request: Request
): Promise<SharePayload> {
  await env.DB.prepare(
    `UPDATE document_links SET active = 0, updated_at = unixepoch() WHERE document_id = ?`
  )
    .bind(docId)
    .run();
  return getShare(env, docId, request);
}

function sharePayload(row: ShareRow | null, request: Request): SharePayload {
  if (!row) return { active: false, code: null, url: null };
  const code = row.code;
  const url = `${requestOrigin(request)}/share/${code}`;
  return { active: row.active === 1, code, url };
}

function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

function randomShareCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ShareRow {
  code: string;
  active: number;
  updated_at?: number;
}

interface SharePayload {
  active: boolean;
  code: string | null;
  url: string | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
