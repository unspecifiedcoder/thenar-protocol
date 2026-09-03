-- T-017 — trajectory index for `dedup.v1` (PLAN.md Sec10.9 check id 0x0001).
--
-- Applied to the SAME SQLite database the log service uses
-- (`services/log/src/schema.sql`), via `TrajectoryIndex`'s own
-- `db.exec(readFileSync(...))` call — this file is never merged into or
-- referenced by `services/log/src/schema.sql` (T-017 supervisor
-- instruction: "do not edit services/log/src/schema.sql"). Idempotent,
-- same style as that file, so opening an existing database re-applies it
-- harmlessly.
--
-- `traj_fingerprint.f` holds the resampled (10Hz), per-joint-normalised
-- state trajectory for the episode at `leaf` (flattened `frames x dof`
-- float32, row-major) — not just the LSH summary descriptor. Two things
-- read it: (a) the cosine-LSH descriptor (32-bin velocity histogram + 8
-- DCT-II coefficients per joint, TASK-017.md step 2) is derived from it on
-- the fly, at both insert and query time, to place/look up `traj_lsh`
-- bucket rows; (b) the banded-DTW refinement (TASK-017.md step 4) runs
-- directly on it against the querying episode's own resampled trajectory.
-- Storing only the fixed-size LSH descriptor (as the task's one-line
-- `traj_fingerprint(leaf, embodiment, f BLOB)` sketch could also be read)
-- would leave DTW with nothing to compare — DTW needs the two aligned
-- time series, not their bucket summary. `dof`/`frames` are recorded
-- alongside `f` so a reader can reconstruct the matrix without consulting
-- the embodiment registry (an unknown/removed embodiment id must not break
-- index round-trips).
CREATE TABLE IF NOT EXISTS traj_fingerprint (
  leaf       TEXT PRIMARY KEY,
  embodiment TEXT NOT NULL,
  dof        INTEGER NOT NULL,
  frames     INTEGER NOT NULL,
  f          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS traj_fingerprint_embodiment ON traj_fingerprint(embodiment);

-- One row per (LSH table, bucket, leaf): 8 tables x 16 planes each
-- (TASK-017.md "cosine-LSH 16 planes x 8 tables with a fixed seed").
-- `bucket` is the 16-bit sign pattern of the 16 planes for that table,
-- stored as decimal text.
CREATE TABLE IF NOT EXISTS traj_lsh (
  table_no INTEGER NOT NULL,
  bucket   TEXT NOT NULL,
  leaf     TEXT NOT NULL,
  PRIMARY KEY (table_no, bucket, leaf)
);
CREATE INDEX IF NOT EXISTS traj_lsh_lookup ON traj_lsh(table_no, bucket);
