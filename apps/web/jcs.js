/* jcs.js — RFC 8785 JSON Canonicalization Scheme, ported for the browser.
 *
 * Byte-for-byte port of `packages/protocol/src/canonical.ts`. Every schema
 * in PLAN §9 hashes as `keccak256(utf8(JCS(object)))` (D-5); the verify page
 * has to reproduce that exactly to recompute `manifestHash`,
 * `corpusManifestHash`, `report_hash`, `detailHash`, and every other
 * commitment named in a report. `verify.test.mjs` checks this module against
 * the `jcs` fixture in `packages/protocol/test/fixtures/vectors.json`.
 */
import { keccak256, hexToBytes, bytesToHex } from "./keccak.js";

/** RFC 8785 §3.2.2.2 — escape only the quote, backslash, and control range. */
function serializeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** RFC 8785 §3.2.2.3 — ECMAScript `Number::toString`. */
function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError("canonicalJson: NaN and Infinity are not valid JSON numbers");
  }
  if (Object.is(n, -0)) return "0";
  return n.toString();
}

/** UTF-16 code-unit order — exactly `Array.prototype.sort()` with no comparator. */
function sortedKeys(o) {
  return Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
}

function serialize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return serializeNumber(value);
  if (t === "string") return serializeString(value);
  if (t === "bigint") {
    throw new TypeError("canonicalJson: bigint is not JSON — pass a decimal string (PLAN §9)");
  }
  if (Array.isArray(value)) {
    // RFC 8785: array element order MUST NOT be changed.
    const parts = value.map((v) => {
      if (v === undefined) throw new TypeError("canonicalJson: undefined is not allowed inside an array");
      return serialize(v);
    });
    return `[${parts.join(",")}]`;
  }
  if (t === "object") {
    const parts = sortedKeys(value).map((k) => `${serializeString(k)}:${serialize(value[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${t}`);
}

/** RFC 8785 canonical JSON text for `value`. Pure; no I/O. */
export function canonicalJson(value) {
  return serialize(value);
}

const utf8Bytes = (s) => new TextEncoder().encode(s);

/** `keccak256(utf8(JCS(value)))` — PLAN §9 D-5. */
export function hashObject(value) {
  return keccak256(bytesToHex(utf8Bytes(canonicalJson(value))));
}

/** `keccak256(utf8(JCS(value without the named top-level keys)))`. */
export function hashObjectExcluding(value, keys) {
  const excluded = new Set(keys);
  const rest = {};
  for (const k of Object.keys(value)) {
    if (!excluded.has(k)) rest[k] = value[k];
  }
  return hashObject(rest);
}

// re-exported for convenience so callers need not import keccak.js separately
export { hexToBytes, bytesToHex };
