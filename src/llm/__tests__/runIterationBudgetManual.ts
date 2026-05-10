/**
 * Manual test for escalation-based iteration budget extension.
 *
 * Run after building dist, or point ZONE_AGENT_LOOP_MODULE at a compiled copy:
 *   node --experimental-strip-types src/llm/__tests__/runIterationBudgetManual.ts
 */
const modulePath =
  process.env.ZONE_AGENT_LOOP_MODULE || "../../../dist/llm/agentLoop.js";
const {
  BASE_MAX_ITERATIONS,
  ESCALATION_BONUS_ITERATIONS,
  maybeGrantEscalationBonus,
} = await import(modulePath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

function simulateLoop(escalationIters) {
  const progress = [];
  const escalatedFiles = new Set();
  let state = {
    maxIterationsForRun: BASE_MAX_ITERATIONS,
    escalationBonusGranted: false,
  };
  const executedIters = [];

  for (let iter = 0; iter < state.maxIterationsForRun; iter += 1) {
    executedIters.push(iter);
    progress.push(JSON.stringify({
      event: "iteration",
      iter,
      iterationCap: state.maxIterationsForRun,
    }));

    if (escalationIters.has(iter)) {
      escalatedFiles.add(`file-${iter}.ts`);
      state = maybeGrantEscalationBonus(
        state,
        escalatedFiles.size,
        iter,
        (msg) => progress.push(msg),
        BASE_MAX_ITERATIONS
      );
    }
  }

  return { progress, executedIters, state };
}

const checks = [];

const ESCALATED_CAP = BASE_MAX_ITERATIONS + ESCALATION_BONUS_ITERATIONS;

{
  const result = simulateLoop(new Set());
  const caps = result.progress
    .map((msg) => JSON.parse(msg))
    .filter((evt) => evt.event === "iteration")
    .map((evt) => evt.iterationCap);
  checks.push(check(
    `no escalation keeps cap at BASE (${BASE_MAX_ITERATIONS}) and exits after ${BASE_MAX_ITERATIONS} iterations`,
    result.state.maxIterationsForRun === BASE_MAX_ITERATIONS &&
      caps.every((cap) => cap === BASE_MAX_ITERATIONS) &&
      result.executedIters.length === BASE_MAX_ITERATIONS,
    { caps: [...new Set(caps)], executed: result.executedIters.length }
  ));
}

{
  const result = simulateLoop(new Set([5]));
  const postEscalationCaps = result.progress
    .map((msg) => JSON.parse(msg))
    .filter((evt) => evt.event === "iteration" && evt.iter > 5)
    .map((evt) => evt.iterationCap);
  checks.push(check(
    `escalation raises cap to BASE+BONUS (${ESCALATED_CAP})`,
    result.state.maxIterationsForRun === ESCALATED_CAP &&
      postEscalationCaps.every((cap) => cap === ESCALATED_CAP),
    { postEscalationCaps: [...new Set(postEscalationCaps)] }
  ));
}

{
  const result = simulateLoop(new Set([5, 7]));
  const grants = result.progress
    .map((msg) => JSON.parse(msg))
    .filter((evt) => evt.event === "zone-agent-escalation-bonus-granted");
  checks.push(check(
    "bonus granted only once",
    grants.length === 1 && result.state.maxIterationsForRun === ESCALATED_CAP,
    { grants }
  ));
}

{
  const result = simulateLoop(new Set([5]));
  const expectedLast = ESCALATED_CAP - 1;
  checks.push(check(
    `loop reaches iter ${expectedLast} when bonus is granted`,
    result.executedIters.includes(expectedLast) &&
      result.executedIters.length === ESCALATED_CAP,
    { lastIter: result.executedIters[result.executedIters.length - 1] }
  ));
}

{
  const result = simulateLoop(new Set());
  const expectedLast = BASE_MAX_ITERATIONS - 1;
  checks.push(check(
    `loop stops at iter ${expectedLast} without escalation`,
    result.executedIters[result.executedIters.length - 1] === expectedLast &&
      !result.executedIters.includes(BASE_MAX_ITERATIONS),
    { lastIter: result.executedIters[result.executedIters.length - 1] }
  ));
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `[iteration-budget-test] PASSED ${checks.length - failed.length}/${checks.length} assertions`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
