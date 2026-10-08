import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSemanticFixture } from "../eval/context-fixture.mjs";

test("context semantic fixture is offline, reproducible and retains all 256 sources with independent questions", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL("../eval/context-fixture.mjs", import.meta.url);
  const files = [join(root, "one.json"), join(root, "two.json")];
  const evaluationTime = "2035-06-15T12:00:00.000Z";
  for (const file of files) execFileSync(process.execPath, [script.pathname, "--out", file, "--evaluation-time", evaluationTime], { env: { PATH: process.env.PATH } });
  assert.equal(readFileSync(files[0], "utf8"), readFileSync(files[1], "utf8"));
  const fixture = JSON.parse(readFileSync(files[0], "utf8"));
  assert.equal(fixture.evaluationTime, evaluationTime);
  assert.ok(fixture.sources.every(source => source.sourceTime === "2035-06-14T12:00:00.000Z"));
  assert.equal(fixture.sources.length, 256);
  assert.equal(fixture.sources[255].sourceId, "source-255");
  assert.deepEqual(fixture.versions, ["v1", "v2"]);
  assert.equal(fixture.budgets.requestsPerLease, 12);
  assert.equal(fixture.budgets.toolsPerLease, 40);
  assert.equal(fixture.budgets.timeoutMs, 300_000);
  assert.ok(fixture.questions.some(question => question.sourceIds.includes("source-255")));
  assert.ok(fixture.questions.some(question => question.noteIds.length));
  assert.equal(fixture.authorization, "offline only; model execution requires separate approval");
  assert.throws(() => execFileSync(process.execPath, [script.pathname, "--out", files[0]], { stdio: "pipe" }), /Command failed/, "never overwrite an existing fixture");
});

test("fixture sources stay within the 30-day window at the recorded evaluation time", () => {
  const before = Date.now();
  const current = contextSemanticFixture();
  assert.ok(Date.parse(current.evaluationTime) >= before);
  assert.ok(Date.parse(current.evaluationTime) <= Date.now());
  for (const fixture of [current, contextSemanticFixture(Date.UTC(2040, 0, 1))]) {
    for (const source of fixture.sources) {
      const age = Date.parse(fixture.evaluationTime) - Date.parse(source.sourceTime);
      assert.ok(age > 0 && age < 30 * 24 * 60 * 60 * 1_000);
    }
  }
});
