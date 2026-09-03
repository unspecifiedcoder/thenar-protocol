/** T-018 — `timing.v1` unit tests (TASK-018.md "Tests"). */
import { timingCheck, CHECK_VERSION } from "../src/checks/timing.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const RATE = 30;
/** N clean, evenly spaced timestamps at `RATE` Hz starting at 0. */
function cleanTimestamps(n: number, rate = RATE): number[] {
  return Array.from({ length: n }, (_, i) => i / rate);
}

// --- clean -------------------------------------------------------------
{
  const n = 90; // 3s at 30Hz
  const out = timingCheck({ timestamp: cleanTimestamps(n) }, RATE, (n / RATE) * 1000);
  ok(out.result === "pass", "clean timestamps pass");
  ok(out.level === 3, "level is 3");
  ok(out.detail.check_version === CHECK_VERSION, "detail carries check_version");
  ok(typeof out.detail.thresholds === "object" && out.detail.thresholds !== null, "detail carries thresholds");
}

// --- video-locked rate (declared 30, actual 29.97) ----------------------
{
  const n = 90;
  const actualRate = 29.97;
  const ts = Array.from({ length: n }, (_, i) => i / actualRate);
  const out = timingCheck({ timestamp: ts }, RATE, (n / RATE) * 1000);
  ok(out.result === "pass", "29.97 vs declared 30 is within tolerance (Edge cases)");
}

// --- dropped frames (one large gap) -------------------------------------
{
  const n = 90;
  const ts = cleanTimestamps(n);
  // Drop several frames worth of time at frame 40: gap > 5/rate.
  const dropped = ts.map((t, i) => (i >= 40 ? t + 10 / RATE : t));
  const out = timingCheck({ timestamp: dropped }, RATE, (n / RATE) * 1000);
  ok(out.result === "fail", "dropped frames (large gap) fail");
  ok(out.detail.offending_frame === 40, "first offending frame is reported", String(out.detail.offending_frame));
}

// --- duplicated timestamps (not strictly increasing) --------------------
{
  const n = 90;
  const ts = cleanTimestamps(n);
  const dup = ts.slice();
  dup[41] = dup[40]; // duplicate: frame 41 repeats frame 40's timestamp
  const out = timingCheck({ timestamp: dup }, RATE, (n / RATE) * 1000);
  ok(out.result === "fail", "duplicated timestamps fail");
  ok(out.detail.offending_frame === 41, "offending frame points at the duplicate", String(out.detail.offending_frame));
  ok(out.detail.reason === "timestamp not strictly increasing", "reason names the violated rule");
}

// --- frame count outside tolerance (too few frames for declared duration) -
{
  const n = 80; // declared duration implies 90 frames at 30Hz; off by 10 > tolerance of 2
  const ts = cleanTimestamps(n);
  const out = timingCheck({ timestamp: ts }, RATE, (90 / RATE) * 1000);
  ok(out.result === "fail", "frame count far outside tolerance fails");
  ok(out.detail.reason === "frame count out of tolerance", "reason names the violated rule");
}

// --- frame count within +-2 tolerance passes -----------------------------
{
  const n = 88; // within +-2 of 90
  const ts = cleanTimestamps(n);
  const out = timingCheck({ timestamp: ts }, RATE, (90 / RATE) * 1000);
  ok(out.result === "pass", "frame count within +-2 tolerance passes");
}

// --- empty frames --------------------------------------------------------
{
  const out = timingCheck({ timestamp: [] }, RATE, 0);
  ok(out.result === "fail", "no frames fails");
}

// --- rate_hz not positive -> inconclusive --------------------------------
{
  const out = timingCheck({ timestamp: cleanTimestamps(10) }, 0, 1000);
  ok(out.result === "inconclusive", "non-positive rate_hz is inconclusive");
}

console.log(fails === 0 ? "\ntiming.v1: all tests passed\n" : `\ntiming.v1: ${fails} test(s) failed\n`);
process.exit(fails ? 1 : 0);
