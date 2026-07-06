import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env, User } from "./types";

/**
 * Resolve the authenticated user for a request, or null if unauthenticated.
 *
 * Default path: Cloudflare Access. Access sits in front of the Worker, authenticates
 * the user with your IdP, and forwards a signed JWT. We verify it against the team's
 * JWKS and trust the `sub`/`email` claims.
 *
 * Local path: if DEV_AUTH_BYPASS is set (see .dev.vars), return a fixed dev user so you
 * can build without an Access app. Never set that in production.
 */

// Cache one JWKS resolver per team domain across requests in the same isolate.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwks = createRemoteJWKSet(url);
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export async function authenticate(request: Request, env: Env): Promise<User | null> {
  // --- Local dev bypass ---
  if (env.DEV_AUTH_BYPASS === "1") {
    return { id: "dev-user", email: "dev@localhost", name: "Dev User" };
  }

  // --- Cloudflare Access ---
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token =
      request.headers.get("Cf-Access-Jwt-Assertion") ??
      getCookie(request, "CF_Authorization");
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, getJwks(env.ACCESS_TEAM_DOMAIN), {
        issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
        audience: env.ACCESS_AUD,
      });
      const id = String(payload.sub ?? "");
      const email = String(payload.email ?? "");
      if (!id) return null;
      return { id, email, name: email.split("@")[0] || id };
    } catch {
      return null;
    }
  }

  // --- OIDC-in-the-Worker (stub) ---
  // If you're building a public SaaS with your own login UI instead of Access:
  //   1. Add /auth/login (redirect to IdP) and /auth/callback (exchange code) routes
  //      in index.ts.
  //   2. On callback, verify the id_token, upsert the user in D1, mint a session id,
  //      and store { userId, exp } in KV (env.SESSIONS) behind an httpOnly cookie.
  //   3. Here, read that cookie, look it up in KV, and return the user.
  // const sid = getCookie(request, "sid");
  // if (sid) {
  //   const raw = await env.SESSIONS.get(`session:${sid}`);
  //   if (raw) return JSON.parse(raw) as User;
  // }

  return null;
}

/** Ensure a users row exists for this identity (called after auth on API routes). */
export async function upsertUser(env: Env, user: User): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name`
  )
    .bind(user.id, user.email, user.name)
    .run();
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
