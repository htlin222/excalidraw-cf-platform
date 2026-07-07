import type { Env } from "../types";

const SHARE_CODE_RE = /^[a-f0-9]{64}$/;

/**
 * Public share-code lookup. The Worker is still behind Cloudflare Access in
 * production, so "public" here means any authenticated user with an active link.
 */
export async function handleShare(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "not found" }, 404);

  const match = path.match(/^\/api\/share\/([a-f0-9]{64})$/);
  if (!match) return json({ error: "not found" }, 404);

  const share = await resolveActiveShare(env, match[1]!);
  if (!share) return json({ error: "share link inactive" }, 404);

  return json({
    document: {
      id: share.documentId,
      title: share.title,
    },
    share: {
      code: share.code,
      active: true,
    },
  });
}

export async function shareCodeMatches(
  env: Env,
  code: string | null,
  documentId: string
): Promise<boolean> {
  if (!code || !SHARE_CODE_RE.test(code)) return false;
  const share = await resolveActiveShare(env, code);
  return share?.documentId === documentId;
}

async function resolveActiveShare(env: Env, code: string): Promise<ActiveShare | null> {
  if (!SHARE_CODE_RE.test(code)) return null;
  const row = await env.DB.prepare(
    `SELECT l.code, l.document_id, d.title
       FROM document_links l
       JOIN documents d ON d.id = l.document_id
      WHERE l.code = ? AND l.active = 1`
  )
    .bind(code)
    .first<ActiveShareRow>();

  if (!row) return null;
  return { code: row.code, documentId: row.document_id, title: row.title };
}

interface ActiveShareRow {
  code: string;
  document_id: string;
  title: string;
}

interface ActiveShare {
  code: string;
  documentId: string;
  title: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
