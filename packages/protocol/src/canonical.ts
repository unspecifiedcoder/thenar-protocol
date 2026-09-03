import { keccak256, toHex, type Hex } from "viem";

/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * Every schema in PLAN §9 hashes as `keccak256(utf8(JCS(object)))` (D-5).
 * This is the one place that byte layout is decided; everything else in the
 * protocol that computes a commitment goes through `hashObject` /
 * `hashObjectExcluding` so a drift here would break every manifest hash at
 * once (PLAN §5 I-5, I-10).
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type JsonObject = { [k: string]: JsonValue };

/**
 * RFC 8785 §3.2.2.2 / ECMA-262 §24.3.2.2: escape only the quote, the
 * backslash, and the ASCII control range U+0000-U+001F (with the five
 * mnemonic escapes for \b \t \n \f \r). Everything else — including all
 * non-ASCII code points — is emitted "as is" and turned into UTF-8 bytes
 * later, by `hashObject`. Iterating by UTF-16 code unit (not code point) is
 * deliberate: surrogate halves of an astral character pass through
 * unmodified and recombine correctly when the string is later UTF-8 encoded.
 */
function serializeString(s: string): string {
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

/**
 * RFC 8785 §3.2.2.3: ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20),
 * which is exactly what `number.toString()` / template-literal coercion
 * already do in a JS engine. `-0` prints as `"0"` (both by the spec and by
 * `(-0).toString()`); `NaN` and `±Infinity` are not permitted in JSON and
 * must throw rather than silently serialise as `null` or a string.
 */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError("canonicalJson: NaN and Infinity are not valid JSON numbers");
  }
  if (Object.is(n, -0)) return "0";
  return n.toString();
}

/**
 * Object key order is UTF-16 code-unit order (RFC 8785 §3.2.3), which is
 * exactly what `Array.prototype.sort()` does with no comparator — it
 * stringifies and compares with `<`, i.e. by UTF-16 code unit. Passing an
 * explicit comparator here would risk someone "helpfully" swapping in
 * `localeCompare` later (PLAN §27 trap #2), so the absence of one is
 * deliberate.
 */
function sortedKeys(o: JsonObject): string[] {
  return Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return serializeNumber(value as number);
  if (t === "string") return serializeString(value as string);
  if (t === "bigint") {
    throw new TypeError(
      "canonicalJson: bigint is not JSON — pass a decimal string (PLAN §9)",
    );
  }
  if (Array.isArray(value)) {
    // RFC 8785: array element order MUST NOT be changed — JCS sorts object
    // properties, never arrays (PLAN §27 trap #1).
    const parts = value.map((v) => {
      if (v === undefined) {
        throw new TypeError("canonicalJson: undefined is not allowed inside an array");
      }
      return serialize(v);
    });
    return `[${parts.join(",")}]`;
  }
  if (t === "object") {
    const obj = value as JsonObject;
    const parts = sortedKeys(obj).map((k) => `${serializeString(k)}:${serialize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${t}`);
}

/** RFC 8785 canonical JSON text for `value`. Pure; no I/O. */
export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

/** `keccak256(utf8(JCS(value)))` — PLAN §9 D-5. */
export function hashObject(value: JsonValue): Hex {
  return keccak256(toHex(canonicalJson(value)));
}

/**
 * `keccak256(utf8(JCS(value without the named top-level keys)))`.
 * Used to hash a signed record excluding its own `signature` field
 * (PLAN §10.6 — claim and append-receipt `objectHash`).
 */
export function hashObjectExcluding(value: JsonObject, keys: string[]): Hex {
  const excluded = new Set(keys);
  const rest: JsonObject = {};
  for (const k of Object.keys(value)) {
    if (!excluded.has(k)) rest[k] = value[k];
  }
  return hashObject(rest);
}
