import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("context semantic fixture is offline, reproducible and retains all 256 sources with independent questions", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL("../eval/context-fixture.mjs", import.meta.url);
  const files = [join(root, "one.json"), join(root, "two.json")];
  for (const file of files) execFileSync(process.execPath, [script.pathname, "--out", file], { env: { PATH: process.env.PATH } });
  assert.equal(readFileSync(files[0], "utf8"), readFileSync(files[1], "utf8"));
  const fixture = JSON.parse(readFileSync(files[0], "utf8"));
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
