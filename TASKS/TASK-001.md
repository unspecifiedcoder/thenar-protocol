# T-001 — Canonical JSON (JCS) and object hashing

**Tier:** STRONG. Deterministic serialisation is on the hashing path (I-4,
I-5); subtle number/Unicode handling matters. No architectural judgement
needed — the rule is fixed (RFC 8785).

## Objective
Provide one function that turns any manifest/record/claim object into the
exact bytes that are hashed, per PLAN §4 D-5, and one that hashes them.

## Context
`packages/protocol/src/taskspec.ts` has `canonicalise()` (sorted keys, no
whitespace, `undefined` dropped). It is JCS-compatible for the value types
used but is not named or tested as JCS. Every schema in PLAN §9 hashes as
`keccak256(JCS(object))`.

## Dependencies
None.

## Files
- Create `packages/protocol/src/canonical.ts`
- Modify `packages/protocol/src/taskspec.ts` (import `canonicalJson` from
  `canonical.ts`; keep `canonicalise` as a deprecated alias)
- Modify `packages/protocol/src/index.ts` (export)
- Create `packages/protocol/test/canonical.ts`; register in `package.json`
  `test:protocol` and in `packages/protocol/test/ci.ts` guard.

## Interfaces
```ts
export function canonicalJson(value: JsonValue): string;          // RFC 8785
export function hashObject(value: JsonValue): Hex;                 // keccak256(utf8(canonicalJson(value)))
export function hashObjectExcluding(value: JsonObject, keys: string[]): Hex; // e.g. manifest without "signature"
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
```

## Expected behaviour
- Keys sorted by UTF-16 code units; no whitespace; strings escaped per JCS
  (only `"`, `\`, control chars; non-ASCII emitted raw UTF-8).
- Numbers serialised per ES `Number.prototype.toString` (JCS §3.2.2.3);
  reject `NaN`, `±Infinity` (throw `TypeError`).
- `undefined` properties are dropped; `undefined` in arrays throws.
- `bigint` throws — callers must pass decimal strings (as PLAN §9 does).
- `hashObjectExcluding` removes top-level keys before serialising.

## Constraints
No new dependencies. Pure function; no I/O.

## Edge cases
Empty object `{}` → `"{}"`; nested empty array; keys that differ only in case
(`"A"` < `"a"`); keys with surrogate pairs ordered by code units, not code
points (JCS rule); `-0` → `"0"`; `1e21` → `"1e+21"`; `0.1+0.2` → `"0.30000000000000004"`.

## Tests
- The RFC 8785 Appendix examples as fixtures (copy verbatim).
- Idempotence: `canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x)`.
- Property: key insertion order never changes output (shuffle 100 times).
- Existing `taskId` vectors in `packages/protocol/test/run.ts` still pass.

## Acceptance
All above pass; `pnpm test:protocol` green; `ci.ts` guard lists the new
suite.

## Security
Any divergence between this and a third-party JCS implementation breaks
every manifest hash. Cross-check against a second implementation's output
for the Appendix fixtures (hard-code the expected strings; do not compute).
