/**
 * T-001 -- RFC 8785 (JCS) canonicalisation and object hashing.
 *
 * The two fixtures marked "RFC 8785 SECREF" below are reproduced from
 * https://www.rfc-editor.org/rfc/rfc8785.txt (fetched 2026-09-03): the
 * worked example in Section 3.2.2/3.2.3/3.2.4 (its expected output and
 * UTF-8 byte dump are given verbatim by the RFC and cross-checked against
 * each other below), and the property-sorting vector in Section 3.2.3
 * (the RFC gives the input object and the expected *sort order of the
 * values*, not the fully serialised string; the expected string here is
 * assembled by hand from that order plus Section 3.2.2.2's escaping rule --
 * escape only U+0000-U+001F, the quote and the backslash; every other code
 * point, including astral ones via their surrogate pair, passes through
 * unescaped -- and is independently cross-checked against a small
 * hand-written serialiser, not the implementation under test, in the
 * derivation script kept alongside this task's notes).
 *
 * These are hard-coded, not computed from `canonicalJson` itself -- a
 * divergence here would break every manifest hash silently (PLAN Sec5
 * I-5, I-10; Sec27 trap #1).
 */
import { canonicalJson, hashObject, hashObjectExcluding, type JsonValue } from "../src/canonical";
import { canonicalise, taskId, type TaskSpec } from "../src/taskspec";
import { keccak256, toHex } from "viem";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` -- ${x}` : ""}`); };

// ------------------------------------------------------- RFC 8785 SS3.2.2-3.2.4
// Parsed JSON: {"numbers":[333333333.33333329,1E30,4.50,2e-3,1e-27-ish],
// "string":<RFC's escape sequence for EURO SIGN,'$',SI(0x0F),LF,'A',"'",'B',
// QUOTATION MARK,REVERSE SOLIDUS,REVERSE SOLIDUS,QUOTATION MARK,'/'>,
// "literals":[null,true,false]}. Building the "string" value from numeric
// code points, not by pasting raw Unicode into this source file.
const rfcStringValue = String.fromCharCode(0x20ac) + "$" + String.fromCharCode(0x0f)
  + String.fromCharCode(0x0a) + "A'B" + String.fromCharCode(0x22)
  + String.fromCharCode(0x5c) + String.fromCharCode(0x5c) + String.fromCharCode(0x22) + "/";
const rfcExample = {
  literals: [null, true, false],
  numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
  string: rfcStringValue,
};
// RFC 8785 SS3.2.3, reproduced verbatim (also cross-checked byte-for-byte
// against the RFC's own SS3.2.4 UTF-8 hex dump when these fixtures were derived).
const rfcExampleExpected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
ok(canonicalJson(rfcExample as unknown as JsonValue) === rfcExampleExpected,
   "RFC 8785 worked example (SS3.2.2-3.2.4) matches verbatim");

// ------------------------------------------------------- RFC 8785 SS3.2.3 sorting
// RFC 8785's property-sorting test vector. Ascending UTF-16 code-unit order
// of the keys (from the RFC): "\r"(U+000D) < "1"(U+0031) < control(U+0080)
// < "o-umlaut"(U+00F6) < euro(U+20AC) < grinning-face(surrogate lead U+D83D)
// < hebrew-dalet-dagesh(U+FB33) -- exactly the order the RFC states.
const sortingInput: JsonValue = {
  '€': 'Euro Sign',
  '\r': 'Carriage Return',
  'דּ': 'Hebrew Letter Dalet With Dagesh',
  '1': 'One',
  '😀': 'Emoji: Grinning Face',
  '': 'Control',
  'ö': 'Latin Small Letter O With Diaeresis',
};
const sortingExpected = '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
ok(canonicalJson(sortingInput) === sortingExpected,
   "RFC 8785 SS3.2.3 property-sorting vector -- hand-derived expected string");

// ------------------------------------------------------------- Appendix B
// Appendix B, "ECMAScript-Compatible JSON Number Serialization Samples" --
// each [number literal, expected JSON text] pair copied verbatim. The
// decimal literals below parse in JS to exactly the IEEE-754 bit patterns
// the RFC's "IEEE 754" column names, so no hex/DataView reconstruction is
// needed.
const numberSamples: [number, string][] = [
  [0, "0"],
  [-0, "0"], // Minus zero
  [5e-324, "5e-324"], // Min pos number
  [-5e-324, "-5e-324"], // Min neg number
  [1.7976931348623157e308, "1.7976931348623157e+308"], // Max pos number
  [-1.7976931348623157e308, "-1.7976931348623157e+308"], // Max neg number
  [9007199254740992, "9007199254740992"], // Max pos int
  [-9007199254740992, "-9007199254740992"], // Max neg int
  [295147905179352830000, "295147905179352830000"], // ~2**68
  [9.999999999999997e22, "9.999999999999997e+22"],
  [1e23, "1e+23"],
  [1.0000000000000001e23, "1.0000000000000001e+23"],
  [999999999999999700000, "999999999999999700000"],
  [999999999999999900000, "999999999999999900000"],
  [1e21, "1e+21"],
  [9.999999999999997e-7, "9.999999999999997e-7"],
  [0.000001, "0.000001"],
  [333333333.3333332, "333333333.3333332"],
  [333333333.33333325, "333333333.33333325"],
  [333333333.3333333, "333333333.3333333"],
  [333333333.3333334, "333333333.3333334"],
  [333333333.33333343, "333333333.33333343"],
  [-0.0000033333333333333333, "-0.0000033333333333333333"],
  [1424953923781206.2, "1424953923781206.2"], // round-to-even
];
let numFails = 0;
for (const [n, expected] of numberSamples) {
  if (canonicalJson(n) !== expected) numFails++;
}
ok(numFails === 0, "RFC 8785 Appendix B number samples", `${numberSamples.length - numFails}/${numberSamples.length}`);

ok((() => { try { canonicalJson(NaN); return false; } catch (e) { return e instanceof TypeError; } })(),
   "NaN throws TypeError");
ok((() => { try { canonicalJson(Infinity); return false; } catch (e) { return e instanceof TypeError; } })(),
   "Infinity throws TypeError");
ok((() => { try { canonicalJson(-Infinity); return false; } catch (e) { return e instanceof TypeError; } })(),
   "-Infinity throws TypeError");
ok((() => { try { canonicalJson(1n as unknown as JsonValue); return false; } catch (e) { return e instanceof TypeError; } })(),
   "bigint throws TypeError");
ok((() => { try { canonicalJson([undefined as unknown as JsonValue]); return false; } catch (e) { return e instanceof TypeError; } })(),
   "undefined in an array throws TypeError");

// ------------------------------------------------------------- Edge cases
ok(canonicalJson({}) === "{}", "empty object");
ok(canonicalJson([]) === "[]", "empty array");
ok(canonicalJson({ a: [] }) === '{"a":[]}', "nested empty array");
ok(canonicalJson({ a: undefined as unknown as JsonValue, b: 1 }) === '{"b":1}',
   "undefined object property is dropped");
ok(canonicalJson({ A: 1, a: 2 }) === '{"A":1,"a":2}', 'key "A" sorts before "a" (0x41 < 0x61)');
// Array element order is never touched, even when elements are objects with
// keys to sort.
ok(canonicalJson([{ b: 1, a: 2 }, { z: 1, a: 2 }]) === '[{"a":2,"b":1},{"a":2,"z":1}]',
   "array order is preserved; only object keys are sorted (JCS does not sort arrays)");

// ------------------------------------------------------------- Idempotence
for (const [name, v] of Object.entries({ rfcExample, sortingInput, empty: {}, nested: { a: [1, 2, { b: 3 }] } })) {
  const once = canonicalJson(v as JsonValue);
  const twice = canonicalJson(JSON.parse(once));
  ok(once === twice, `idempotent: canonicalJson(parse(canonicalJson(x))) === canonicalJson(x)`, name);
}

// ------------------------------------------------------- Key-order property
{
  const keys = ["zebra", "apple", "Banana", "1", "_x", String.fromCharCode(0xe9) + "clair",
                String.fromCharCode(0x65e5) + String.fromCharCode(0x672c) + String.fromCharCode(0x8a9e)];
  const base: Record<string, number> = {};
  keys.forEach((k, i) => (base[k] = i));
  const canonical = canonicalJson(base as unknown as JsonValue);
  let allMatch = true;
  for (let i = 0; i < 100; i++) {
    const shuffled: Record<string, number> = {};
    const order = [...keys];
    for (let j = order.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
    for (const k of order) shuffled[k] = base[k];
    if (canonicalJson(shuffled as unknown as JsonValue) !== canonical) allMatch = false;
  }
  ok(allMatch, "key insertion order never changes output (100 shuffles)");
}

// ------------------------------------------------------------- hashObject
{
  const h1 = hashObject({ a: 1, b: 2 } as unknown as JsonValue);
  const h2 = keccak256(toHex(canonicalJson({ b: 2, a: 1 } as unknown as JsonValue)));
  ok(h1 === h2, "hashObject === keccak256(utf8(canonicalJson(value)))");
}
{
  const withSig = { a: 1, b: 2, signature: "0xdead" } as unknown as JsonValue;
  const withoutSig = hashObjectExcluding(withSig as Record<string, JsonValue>, ["signature"]);
  const expected = hashObject({ a: 1, b: 2 } as unknown as JsonValue);
  ok(withoutSig === expected, "hashObjectExcluding drops the named top-level keys before hashing");
}

// ------------------------------------------------------ deprecated alias
ok(canonicalise({ b: 2, a: 1 }) === canonicalJson({ b: 2, a: 1 } as unknown as JsonValue),
   "canonicalise() delegates to canonicalJson()");

// -------------------------------------------------- existing taskId vectors
{
  const spec: TaskSpec = {
    version: 1,
    embodiment: "franka_panda",
    actionSpace: "ee_pose_gripper",
    instruction: "Place the mug upright on the shelf",
    world: {
      base: "kitchen_counter_v2",
      objects: [
        { category: "mug", instances: ["mug_a", "mug_b", "mug_c"],
          x: [0.28, 0.42], y: [-0.15, 0.15], yaw: [0, 6.283] },
      ],
    },
    success: { predicate: "upright_on(mug, shelf)", toleranceMm: 5, settleS: 1 },
    acceptance: { minScoreBps: 8000, maxDurationS: 30, targetEpisodes: 200 },
  };
  const id1 = taskId(spec);
  const id2 = taskId(JSON.parse(JSON.stringify(spec)) as TaskSpec);
  ok(id1 === id2, "taskId is stable across a JSON round-trip");
  ok(/^0x[0-9a-f]{64}$/.test(id1), "taskId is a 32-byte hex hash");
}

console.log(fails === 0 ? "\ncanonical (JCS): all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
