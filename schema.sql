-- D1 schema: the control plane. Apply with:
--   wrangler d1 execute excalidraw-platform --remote --file=./schema.sql
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- stable subject from the IdP (Access "sub")
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,          -- also the room id for the Durable Object
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL DEFAULT 'Untitled',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id, updated_at DESC);

-- Per-document access grants. role in ('owner','editor','viewer').
CREATE TABLE IF NOT EXISTS shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'viewer',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

-- Opaque share links for live collaborative editing. The code is a high-entropy,
-- SHA-like token used in /share/:code URLs; active=0 disables new link joins.
CREATE TABLE IF NOT EXISTS document_links (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_document_links_code ON document_links(code);

-- Reserved for Milestone 6 (multi-tenant). Left here so migrations stay additive.
-- CREATE TABLE IF NOT EXISTS workspaces (...);
-- CREATE TABLE IF NOT EXISTS workspace_members (...);
