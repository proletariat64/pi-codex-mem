import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHostCompat, REQUIRED_EVENTS, type HostCapabilities } from "../src/pi/compat.ts";

function goodCaps(): HostCapabilities {
  return {
    nodeVersion: "24.16.0",
    piVersion: "0.99.2",
    hasNodeSqlite: true,
    events: [...REQUIRED_EVENTS],
    hasNativeRunAbort: true,
    hasLeadingSystemPreservation: true,
    hasToolPreservation: true,
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

test("missing branch access and model registry are each reported", () => {
  const result = checkHostCompat({
    ...goodCaps(),
    hasBranchAccess: false,
    hasModelRegistryAccess: false,
  });
  assert.equal(result.supported, false);
  assert.ok(result.problems.some((p) => p.includes("branch")));
  assert.ok(result.problems.some((p) => p.includes("model registry")));
});

test("revision 4 requires both request-local transformation and pre-provider boundary", () => {
  for (const event of ["context_with_system", "before_provider_request"] as const) {
    assert.ok(REQUIRED_EVENTS.includes(event));
    const result = checkHostCompat({ ...goodCaps(), events: REQUIRED_EVENTS.filter((e) => e !== event) });
    assert.equal(result.supported, false);
    assert.ok(result.problems.some((p) => p.includes(event)));
  }
});

test("native whole-run abort and system/tool preservation are independently required", () => {
  for (const [capability, detail] of [
    ["hasNativeRunAbort", "whole-run abort"],
    ["hasLeadingSystemPreservation", "leading system"],
    ["hasToolPreservation", "tool declaration"],
  ] as const) {
    const result = checkHostCompat({ ...goodCaps(), [capability]: false });
    assert.equal(result.supported, false);
    assert.equal(result.problems.length, 1);
    assert.ok(result.problems[0]?.includes(detail));
  }
});

test("structured prompt sections are not a revision 4 requirement", () => {
  assert.equal(checkHostCompat(goodCaps()).supported, true);
  assert.equal(checkHostCompat({ ...goodCaps(), hasStructuredPromptSections: false }).supported, true);
});

test("Pi versions are metadata, not an exact/minimum allowlist", () => {
  for (const piVersion of ["0.99.1", "0.99.2", "0.99.3", "0.100.0", "1.0.0", "0.99.2-beta", "unknown"]) {
    assert.equal(checkHostCompat({ ...goodCaps(), piVersion }).supported, true, piVersion);
    assert.equal(checkHostCompat({ ...goodCaps(), piVersion, hasNativeRunAbort: false }).supported, false, piVersion);
  }
});

test("malformed Node versions cannot satisfy the minimum", () => {
  assert.equal(checkHostCompat({ ...goodCaps(), nodeVersion: "unknown" }).supported, false);
});
