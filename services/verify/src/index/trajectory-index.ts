/**
 * T-017 — `TrajectoryIndex`: cosine-LSH candidate index for `dedup.v1`
 * (PLAN.md Sec10.9 check id 0x0001, TASK-017.md).
 *
 * Backed by `node:sqlite` (`DatabaseSync`) — the same driver
 * `services/log/src/store.ts` uses, so no new dependency is introduced and
 * no `pnpm install` is required. Applies its own `schema.sql` (see that
 * file for why `f` stores the full resampled trajectory, not just the LSH
 * descriptor) to whatever database path it is given; when pointed at the
 * log service's own SQLite file this adds tables alongside `leaf`/`claim`/
 * etc. without touching `services/log/src/schema.sql`.
 *
 * LSH: 16 random hyperplanes x 8 tables (TASK-017.md), generated from a
 * fixed seed with a small deterministic PRNG (mulberry32) so every process
 * that opens an index computes the identical planes — no plane is ever
 * persisted. Plane dimensionality equals the fingerprint length, which is
 * `dof * (32 + 8)` and therefore varies by embodiment (different DOF);
 * planes are cached per dimension and derived from `seed XOR dimension` so
 * two embodiments never collide on the same plane set.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const LSH_TABLES = 8;
export const LSH_PLANES = 16;
export const HIST_BINS = 32;
export const DCT_K = 8;

/** Fixed seed (TASK-017.md "cosine-LSH ... with a fixed seed"). Never change without bumping `check_version`. */
const LSH_SEED = 0x64656475; // ascii "dedu"

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

// ------------------------------------------------------------- deterministic PRNG

/** mulberry32: small, fast, deterministic given a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const planeCache = new Map<number, Float64Array[][]>(); // dim -> [table][plane] (unit vectors)

function getPlanes(dim: number): Float64Array[][] {
  const cached = planeCache.get(dim);
  if (cached) return cached;
  const rand = mulberry32((LSH_SEED ^ (dim * 2654435761)) >>> 0);
  const tables: Float64Array[][] = [];
  for (let t = 0; t < LSH_TABLES; t++) {
    const planes: Float64Array[] = [];
    for (let p = 0; p < LSH_PLANES; p++) {
      const v = new Float64Array(dim);
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        // Box-Muller: two uniforms -> one Gaussian, for an isotropic random
        // hyperplane normal (standard cosine-LSH construction).
        const u1 = Math.max(rand(), 1e-12);
        const u2 = rand();
        const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v[i] = g;
        norm += g * g;
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) v[i] /= norm;
      planes.push(v);
    }
    tables.push(planes);
  }
  planeCache.set(dim, tables);
  return tables;
}

// ---------------------------------------------------------- fingerprint descriptor

/**
 * Per-joint 32-bin velocity histogram ‖ first 8 DCT-II coefficients
 * (TASK-017.md step 2), concatenated across joints. Used only to place/
 * look up LSH buckets — never persisted on its own (see `schema.sql`).
 */
export function fingerprintDescriptor(trajectory: number[][]): Float64Array {
  const frames = trajectory.length;
  const dof = frames > 0 ? trajectory[0].length : 0;
  const perJoint = HIST_BINS + DCT_K;
  const out = new Float64Array(dof * perJoint);
  for (let j = 0; j < dof; j++) {
    const series = new Array<number>(frames);
    for (let i = 0; i < frames; i++) series[i] = trajectory[i][j];
    const base = j * perJoint;
    velocityHistogramInto(series, out, base);
    dctCoeffsInto(series, out, base + HIST_BINS);
  }
  return out;
}

function velocityHistogramInto(series: number[], out: Float64Array, base: number): void {
  const lo = -1, hi = 1;
  const width = (hi - lo) / HIST_BINS;
  const n = series.length - 1;
  if (n <= 0) return;
  for (let i = 1; i < series.length; i++) {
    const d = series[i] - series[i - 1];
    let bin = Math.floor((d - lo) / width);
    if (bin < 0) bin = 0;
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    out[base + bin] += 1;
  }
  for (let b = 0; b < HIST_BINS; b++) out[base + b] /= n;
}

function dctCoeffsInto(series: number[], out: Float64Array, base: number): void {
  const n = series.length;
  if (n === 0) return;
  for (let k = 0; k < DCT_K; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += series[i] * Math.cos((Math.PI / n) * (i + 0.5) * k);
    out[base + k] = sum / n;
  }
}

function bucketsFor(descriptor: Float64Array): { table: number; bucket: string }[] {
  const planes = getPlanes(descriptor.length);
  const out: { table: number; bucket: string }[] = [];
  for (let t = 0; t < LSH_TABLES; t++) {
    let bits = 0;
    const tablePlanes = planes[t];
    for (let p = 0; p < LSH_PLANES; p++) {
      const plane = tablePlanes[p];
      let dot = 0;
      for (let i = 0; i < descriptor.length; i++) dot += plane[i] * descriptor[i];
      if (dot >= 0) bits |= 1 << p;
    }
    out.push({ table: t, bucket: String(bits) });
  }
  return out;
}

// ---------------------------------------------------------------------- index

export type Candidate = { leaf: string; trajectory: number[][] };

export class TrajectoryIndex {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  close(): void {
    this.db.close();
  }

  /** Row count of `traj_fingerprint` — used as `detail.index_snapshot` (monotonically increasing). */
  rowCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM traj_fingerprint").get() as { c: number };
    return row.c;
  }

  /**
   * ≤ `limit` candidates from the same `embodiment`, via LSH bucket
   * membership across all 8 tables, excluding `excludeLeaf` (an episode is
   * never compared to itself, TASK-017.md).
   */
  query(trajectory: number[][], embodiment: string, excludeLeaf: string, limit = 50): Candidate[] {
    const descriptor = fingerprintDescriptor(trajectory);
    const buckets = bucketsFor(descriptor);
    const lookup = this.db.prepare("SELECT leaf FROM traj_lsh WHERE table_no = ? AND bucket = ?");
    const seen = new Set<string>();
    for (const { table, bucket } of buckets) {
      if (seen.size >= limit) break;
      const rows = lookup.all(table, bucket) as { leaf: string }[];
      for (const row of rows) {
        if (row.leaf === excludeLeaf || seen.has(row.leaf)) continue;
        seen.add(row.leaf);
        if (seen.size >= limit) break;
      }
    }
    if (seen.size === 0) return [];

    const fpStmt = this.db.prepare(
      "SELECT leaf, embodiment, dof, frames, f FROM traj_fingerprint WHERE leaf = ? AND embodiment = ?",
    );
    const out: Candidate[] = [];
    for (const leaf of seen) {
      const row = fpStmt.get(leaf, embodiment) as { leaf: string; dof: number; frames: number; f: Uint8Array } | undefined;
      if (!row) continue; // different embodiment (or, defensively, a missing row)
      out.push({ leaf: row.leaf, trajectory: toMatrix(row.f, row.frames, row.dof) });
    }
    return out.slice(0, limit);
  }

  /** Inserts `trajectory` (its fingerprint bucketed into all 8 LSH tables) after the check has decided (TASK-017.md step 6). */
  insert(leaf: string, embodiment: string, trajectory: number[][]): void {
    const frames = trajectory.length;
    const dof = frames > 0 ? trajectory[0].length : 0;
    const buf = toBuffer(trajectory, frames, dof);
    this.db
      .prepare("INSERT OR REPLACE INTO traj_fingerprint (leaf, embodiment, dof, frames, f) VALUES (?, ?, ?, ?, ?)")
      .run(leaf, embodiment, dof, frames, buf);

    const descriptor = fingerprintDescriptor(trajectory);
    const buckets = bucketsFor(descriptor);
    const ins = this.db.prepare("INSERT OR REPLACE INTO traj_lsh (table_no, bucket, leaf) VALUES (?, ?, ?)");
    for (const { table, bucket } of buckets) ins.run(table, bucket, leaf);
  }
}

function toBuffer(trajectory: number[][], frames: number, dof: number): Buffer {
  const flat = new Float32Array(frames * dof);
  for (let i = 0; i < frames; i++) {
    const row = trajectory[i];
    for (let j = 0; j < dof; j++) flat[i * dof + j] = row[j];
  }
  return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
}

function toMatrix(bytes: Uint8Array, frames: number, dof: number): number[][] {
  const flat = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const out: number[][] = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const row = new Array<number>(dof);
    for (let j = 0; j < dof; j++) row[j] = flat[i * dof + j];
    out[i] = row;
  }
  return out;
}
