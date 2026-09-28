import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHostCompat, REQUIRED_EVENTS, type HostCapabilities } from "../src/pi/compat.ts";

function goodCaps(): HostCapabilities {
  return {
    nodeVersion: "24.16.0",
    hasNodeSqlite: true,
    events: [...REQUIRED_EVENTS],
    hasStructuredPromptSections: true,
    hasBranchAccess: true,
    hasModelRegistryAccess: true,
  };
}

test("a fully capable host is supported with no problems", () => {
  const result = checkHostCompat(goodCaps());
  assert.equal(result.supported, true);
  assert.deepEqual(result.problems, []);
});

test("the spec's minimum Node version is accepted, older is rejected", () => {
  assert.equal(checkHostCompat({ ...goodCaps(), nodeVersion: "22.19.0" }).supported, true);
  const old = checkHostCompat({ ...goodCaps(), nodeVersion: "22.18.0" });
  assert.equal(old.supported, false);
  assert.ok(old.problems.some((p) => p.includes("22.19.0")));
  assert.equal(checkHostCompat({ ...goodCaps(), nodeVersion: "20.0.0" }).supported, false);
});

test("missing node:sqlite is reported", () => {
  const result = checkHostCompat({ ...goodCaps(), hasNodeSqlite: false });
  assert.equal(result.supported, false);
  assert.ok(result.problems.some((p) => p.includes("node:sqlite")));
});

test("each missing required event is named", () => {
  const events = REQUIRED_EVENTS.filter((e) => e !== "agent_settled" && e !== "session_tree");
  const result = checkHostCompat({ ...goodCaps(), events });
  assert.equal(result.supported, false);
  assert.ok(result.problems.some((p) => p.includes("agent_settled")));
  assert.ok(result.problems.some((p) => p.includes("session_tree")));
});

test("missing prompt sections, branch access, and model registry are each reported", () => {
  const result = checkHostCompat({
    ...goodCaps(),
    hasStructuredPromptSections: false,
    hasBranchAccess: false,
    hasModelRegistryAccess: false,
  });
  assert.equal(result.supported, false);
  assert.ok(result.problems.some((p) => p.includes("system prompt sections")));
  assert.ok(result.problems.some((p) => p.includes("branch")));
  assert.ok(result.problems.some((p) => p.includes("model registry")));
});
