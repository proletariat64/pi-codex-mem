import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIdentity } from "../src/identity.ts";

// Spec §5.3: identity = sha256(cwd | projectHint | sessionStart).

test("same cwd + session start produce the same identity (spec §15.1)", () => {
  const a = computeIdentity("/home/u/project", "project", "2026-09-28T08:00:00.000Z");
  const b = computeIdentity("/home/u/project", "project", "2026-09-28T08:00:00.000Z");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("a moved directory produces a different identity (spec §15.1)", () => {
  const a = computeIdentity("/home/u/project", "project", "2026-09-28T08:00:00.000Z");
  const b = computeIdentity("/home/u/project-moved", "project", "2026-09-28T08:00:00.000Z");
  assert.notEqual(a, b);
});

test("a new session start produces a different identity", () => {
  const a = computeIdentity("/home/u/project", "project", "2026-09-28T08:00:00.000Z");
  const b = computeIdentity("/home/u/project", "project", "2026-09-28T09:00:00.000Z");
  assert.notEqual(a, b);
});
