-- THENAR log service — SQLite schema (PLAN.md Sec8 domain model, Sec14 storage).
--
-- Idempotent: every statement is `IF NOT EXISTS` so opening an existing
-- database re-applies this file harmlessly. Column names on `leaf`, `anchor`,
-- `anchor_chain` and `revocation` are kept exactly as T-004/T-007 left them
-- so existing callers (`anchorer.ts`, `cli.ts`, prior tests) keep working;
-- new columns are additive and default to NULL/0 for old rows.
--
-- Append-only (PLAN Sec5 I-2): `leaf`, `anchor`, `anchor_chain`, `revocation`
-- and `claim` reject UPDATE/DELETE outright. `INSERT OR REPLACE`, used by
-- this service's own idempotent re-inserts (a repeated revocation, a replayed
-- anchor_chain row), is unaffected — SQLite only routes a REPLACE conflict's
-- implicit delete through DELETE triggers when `recursive_triggers` is on,
-- and this database never turns that pragma on.

PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------- org / keys

CREATE TABLE IF NOT EXISTS org (
  org_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('supplier', 'buyer', 'verifier')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL
);

-- `key_hash`/`role` (T-024): the sha256 hex digest of the bearer token
-- (only the digest is ever stored, PLAN Sec12 auth) and the role it grants
-- (`auth.ts` `Role`). Additive on top of T-014's original columns, same as
-- every other table on this file.
CREATE TABLE IF NOT EXISTS api_key (
  key_id     TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('supplier', 'buyer', 'verifier', 'operator')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_key_hash ON api_key(key_hash);

CREATE TABLE IF NOT EXISTS signing_key (
  key_id      TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  alg         TEXT NOT NULL CHECK (alg IN ('ed25519', 'p256', 'secp256k1')),
  pubkey      TEXT NOT NULL,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,
  attestation TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked'))
);

-- ------------------------------------------------------------ dataset/upload

CREATE TABLE IF NOT EXISTS dataset (
  dataset_id      TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  source_uri      TEXT,
  info_json_hash  TEXT NOT NULL,
  files_json      TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'committed')),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload (
  hash       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  org_id     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored')),
  created_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------- leaves

-- `leaf` is the log itself — one append-only tree. `idx` is the log index,
-- assigned sequentially by `LogStore.append`. Columns beyond `idx`/`leaf`/
-- `created_at` are optional episode metadata (PLAN Sec8 Episode row); a
-- caller that only has a leaf hash still round-trips.
CREATE TABLE IF NOT EXISTS leaf (
  idx           INTEGER PRIMARY KEY,
  leaf          TEXT NOT NULL UNIQUE,
  preimage      TEXT,
  task_id       TEXT,
  contributor   TEXT,
  quality_score INTEGER,
  success       INTEGER,
  manifest      TEXT,
  manifest_hash TEXT,
  payload_hash  TEXT,
  dataset_id    TEXT,
  org_id        TEXT,
  consent_key   TEXT,
  submitted_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leaf_task ON leaf(task_id);
CREATE INDEX IF NOT EXISTS leaf_org ON leaf(org_id);
CREATE INDEX IF NOT EXISTS leaf_dataset ON leaf(dataset_id);

-- `node(level, idx, hash)` caches every complete-subtree root the tree has
-- ever formed: at level L, idx I holds the root of leaves
-- [I*2^L, I*2^L + 2^L). A row is written only once, the instant that range
-- fills, in the same transaction as the append that completed it — RFC 6962
-- root/inclusion/consistency all read exclusively from this table
-- (`tree.ts`), giving O(log n) queries instead of O(n) leaf replays.
CREATE TABLE IF NOT EXISTS node (
  level INTEGER NOT NULL,
  idx   INTEGER NOT NULL,
  hash  TEXT NOT NULL,
  PRIMARY KEY (level, idx)
);

-- ------------------------------------------------------------------ anchors

-- Legacy single-chain anchor history (primary chain only) — kept exactly as
-- T-007 left it so `lastAnchoredSize()`/`pnpm log status` keep meaning what
-- they meant before mirrors existed.
CREATE TABLE IF NOT EXISTS anchor (
  idx             INTEGER PRIMARY KEY,
  root            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  revocation_root TEXT NOT NULL,
  tx_hash         TEXT,
  block_number    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS anchor_root_size ON anchor(root, size);

-- Per-chain anchor history (PLAN Sec8 Anchor.chains[]) — one row per chain
-- per anchor transaction, so a primary and its mirrors each keep their own
-- on-chain index, tx hash and block number.
CREATE TABLE IF NOT EXISTS anchor_chain (
  chain_id        INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  root            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  revocation_root TEXT,
  block_number    INTEGER,
  tx_hash         TEXT,
  at              INTEGER NOT NULL,
  PRIMARY KEY (chain_id, idx)
);
CREATE INDEX IF NOT EXISTS anchor_chain_root_size ON anchor_chain(root, size);

-- ------------------------------------------------------------- revocations

CREATE TABLE IF NOT EXISTS revocation (
  consent_key TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  received_at INTEGER,
  created_at  INTEGER NOT NULL
);

-- --------------------------------------------------------------- corpus/claim

CREATE TABLE IF NOT EXISTS corpus (
  corpus_id           TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  manifest            TEXT NOT NULL,
  corpus_manifest_hash TEXT NOT NULL,
  corpus_root         TEXT NOT NULL,
  manifest_leaf_hash  TEXT,
  manifest_leaf_idx   INTEGER,
  on_chain_id         TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'logged', 'sealed', 'closed')),
  contains_revoked    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus_episode (
  corpus_id     TEXT NOT NULL,
  leaf_hash     TEXT NOT NULL,
  corpus_index  INTEGER NOT NULL,
  PRIMARY KEY (corpus_id, leaf_hash)
);
CREATE INDEX IF NOT EXISTS corpus_episode_corpus ON corpus_episode(corpus_id);

-- VerificationClaim v1 (PLAN Sec9.3) — one row per claim leaf (0x04).
CREATE TABLE IF NOT EXISTS claim (
  leaf_hash        TEXT PRIMARY KEY,
  subject_leaf     TEXT NOT NULL,
  verifier_key_id  TEXT NOT NULL,
  check_name       TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'inconclusive')),
  level_asserted   INTEGER,
  detail           TEXT NOT NULL,
  detail_hash      TEXT NOT NULL,
  issued_at        INTEGER NOT NULL,
  signature        TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_subject ON claim(subject_leaf);

CREATE TABLE IF NOT EXISTS report (
  report_id      TEXT PRIMARY KEY,
  corpus_id      TEXT NOT NULL,
  anchor_root    TEXT NOT NULL,
  anchor_size    INTEGER NOT NULL,
  report_hash    TEXT NOT NULL,
  json_ref       TEXT,
  pdf_ref        TEXT,
  generated_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------ ops plumbing

CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  response    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job (
  job_id      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  payload     TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ------------------------------------------------------------ append-only

CREATE TRIGGER IF NOT EXISTS leaf_append_only_u BEFORE UPDATE ON leaf BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS leaf_append_only_d BEFORE DELETE ON leaf BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS anchor_append_only_u BEFORE UPDATE ON anchor BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS anchor_append_only_d BEFORE DELETE ON anchor BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS anchor_chain_append_only_u BEFORE UPDATE ON anchor_chain BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS anchor_chain_append_only_d BEFORE DELETE ON anchor_chain BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS revocation_append_only_u BEFORE UPDATE ON revocation BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS revocation_append_only_d BEFORE DELETE ON revocation BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS claim_append_only_u BEFORE UPDATE ON claim BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS claim_append_only_d BEFORE DELETE ON claim BEGIN SELECT RAISE(ABORT, 'append-only'); END;
