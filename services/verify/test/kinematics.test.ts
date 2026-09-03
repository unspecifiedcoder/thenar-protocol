/** T-018 — `kinematics.v1` unit tests (TASK-018.md "Tests"). */
import { kinematicsCheck, CHECK_VERSION } from "../src/checks/kinematics.ts";
import { byId } from "../../../packages/protocol/src/embodiments.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const EMB = "so_arm100";
const RATE = 30;
const embodiment = byId(EMB)!;
ok(!!embodiment.jointLimits && !!embodiment.maxVel, "fixture assumption: so_arm100 has recorded limits");
const DOF = embodiment.jointLimits!.length;

/** N clean frames, all joints at 0, moving slowly (well under maxVel/accel). */
function cleanState(n: number, dof = DOF): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: dof }, () => 0.001 * i));
}

// --- clean ---------------------------------------------------------------
{
  const out = kinematicsCheck({ state: cleanState(60) }, EMB, RATE);
  ok(out.result === "pass", "clean, slow-moving joints pass");
  ok(out.level === 3, "level is 3");
  ok(out.detail.check_version === CHECK_VERSION, "detail carries check_version");
  ok(typeof out.detail.thresholds === "object" && out.detail.thresholds !== null, "detail carries thresholds");
}

// --- out-of-range joints ---------------------------------------------------
{
  const state = cleanState(60);
  state[30] = state[30].slice();
  state[30][2] = 5; // joint 2 limit is [-1.6, 1.6]
  const out = kinematicsCheck({ state }, EMB, RATE);
  ok(out.result === "fail", "out-of-range joint fails");
  ok(out.detail.offending_frame === 30, "offending frame reported", String(out.detail.offending_frame));
  ok(out.detail.offending_joint === 2, "offending joint reported", String(out.detail.offending_joint));
  ok(out.detail.reason === "observation.state joint out of range", "reason names the violated rule");
}

// --- joint limit tolerance (1 degree) is honoured -------------------------
{
  const [, hi] = embodiment.jointLimits![0];
  // Held steady 0.5 degree over the limit for every frame — no velocity
  // involved, isolating the tolerance behaviour of the range check itself.
  const held = hi + 0.5 * (Math.PI / 180);
  const state = Array.from({ length: 10 }, () => Array(DOF).fill(0).map((_, j) => (j === 0 ? held : 0)));
  const out = kinematicsCheck({ state }, EMB, RATE);
  ok(out.result === "pass", "within the 1 degree tolerance still passes");
}

// --- teleporting joints (velocity exceeds maxVel) --------------------------
{
  const state = cleanState(60);
  state[20] = state[20].slice();
  state[20][1] = 1.5; // a single-frame jump: velocity = 1.5 / (1/30) = 45 rad/s >> maxVel
  const out = kinematicsCheck({ state }, EMB, RATE);
  ok(out.result === "fail", "a teleporting joint fails");
  ok(out.detail.offending_frame === 20, "offending frame points at the jump", String(out.detail.offending_frame));
  ok(out.detail.offending_joint === 1, "offending joint reported", String(out.detail.offending_joint));
  ok(out.detail.reason === "observation.state velocity exceeds maxVel", "reason names the violated rule");
}

// --- acceleration spike (velocity itself within maxVel) --------------------
{
  const dt = 1 / RATE;
  // Build a joint-0 trajectory whose velocity alternates +4, -4 rad/s
  // (both under so_arm100's 4.8 rad/s maxVel) so only the >50 rad/s^2
  // acceleration rule is violated, at the flip.
  const n = 10;
  const vel = [1, 1, 1, 4, -4, 1, 1, 1, 1].map((v) => v); // length n - 1
  const state: number[][] = [Array(DOF).fill(0)];
  for (let i = 0; i < vel.length; i++) {
    const prev = state[i][0];
    const frame = Array(DOF).fill(0);
    frame[0] = prev + vel[i] * dt;
    state.push(frame);
  }
  ok(state.length === n, "fixture sanity: n frames built");
  const out = kinematicsCheck({ state }, EMB, RATE);
  ok(out.result === "fail", "an acceleration spike fails");
  ok(out.detail.reason === "observation.state acceleration spike", "reason names the violated rule", String(out.detail.reason));
  ok(out.detail.offending_joint === 0, "offending joint reported");
}

// --- action within limits ---------------------------------------------------
{
  const state = cleanState(20);
  const action = cleanState(20);
  action[10] = action[10].slice();
  action[10][3] = -10; // joint 3 limit is [-1.75, 1.75]
  const out = kinematicsCheck({ state, action }, EMB, RATE);
  ok(out.result === "fail", "out-of-range action fails");
  ok(out.detail.reason === "action joint out of range", "reason names the action series");
  ok(out.detail.offending_frame === 10 && out.detail.offending_joint === 3, "action offending frame/joint reported");
}

// --- action absent -> state-only check (Edge cases) -------------------------
{
  const state = cleanState(20);
  const out = kinematicsCheck({ state }, EMB, RATE);
  ok(out.result === "pass", "action absent: kinematics checks state only, and passes");
}

// --- unknown embodiment -> inconclusive -------------------------------------
{
  const out = kinematicsCheck({ state: cleanState(10) }, "not_a_real_embodiment", RATE);
  ok(out.result === "inconclusive", "unknown embodiment is inconclusive");
  ok(out.detail.reason === "no limits for embodiment", "reason names the missing-limits rule");
}

// --- known embodiment without recorded limits -> inconclusive ---------------
{
  const noLimitsId = "aloha";
  ok(!byId(noLimitsId)?.jointLimits, "fixture assumption: aloha has no recorded limits");
  const out = kinematicsCheck({ state: cleanState(10, byId(noLimitsId)!.dof) }, noLimitsId, RATE);
  ok(out.result === "inconclusive", "an embodiment with no recorded limits is inconclusive");
  ok(out.detail.reason === "no limits for embodiment", "reason names the missing-limits rule");
}

// --- joint count mismatch -> inconclusive -----------------------------------
{
  const out = kinematicsCheck({ state: cleanState(10, DOF + 1) }, EMB, RATE);
  ok(out.result === "inconclusive", "state/embodiment dof mismatch is inconclusive");
}

console.log(fails === 0 ? "\nkinematics.v1: all tests passed\n" : `\nkinematics.v1: ${fails} test(s) failed\n`);
process.exit(fails ? 1 : 0);
