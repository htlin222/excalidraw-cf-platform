/// <reference types="@cloudflare/workers-types" />

export interface Env {
  // Bindings (see wrangler.jsonc)
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  SESSIONS: KVNamespace;
  BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;

  // Vars & secrets
  ENVIRONMENT?: string;
  DEV_AUTH_BYPASS?: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. myteam.cloudflareaccess.com
  ACCESS_AUD?: string; // Access application Audience (AUD) tag
}

export interface User {
  id: string; // stable subject from the IdP
  email: string;
  name: string;
}

/**
 * The subset of an Excalidraw element we rely on for reconciliation. The full element
 * has many more fields; we treat `data` as an opaque JSON blob and only read the three
 * fields below for merge decisions.
 */
export interface SyncElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

// ---- WebSocket protocol ----

export type ClientMessage =
  | { type: "hello" }
  | { type: "update"; elements: SyncElement[] }
  | {
      type: "pointer";
      user: PresenceUser;
      x: number;
      y: number;
      button?: "up" | "down";
      selectedElementIds?: string[];
    };

export type ServerMessage =
  | { type: "init"; elements: SyncElement[] }
  | { type: "update"; elements: SyncElement[] }
  | {
      type: "pointer";
      user: PresenceUser;
      x: number;
      y: number;
      button?: "up" | "down";
      selectedElementIds?: string[];
    }
  | { type: "presence"; users: PresenceUser[] };

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}
