import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRawEvent, type RawEventInput } from "../src/raw-store.ts";
import { redactSensitive } from "../src/sensitive.ts";

function makeRoot(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-raw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseInput(root: string, overrides?: Partial<RawEventInput>): RawEventInput {
  return {
    root,
    identity: "a".repeat(64),
    timezone: "UTC",
    turnIndex: 0,
    role: "user",
    texts: ["hello from the user"],
    canaries: {
      cwdPrefix: true,
      cwdSuffix: false,
      gitCommit: "b".repeat(40),
      artifactPath: "/tmp/agent/memory/artifact-canary.txt",
      artifactSha256: "c".repeat(64),
    },
    at: new Date("2026-09-28T08:00:00.000Z"),
    ...overrides,
  };
}

// Spec §5.1/§15.1: raw events land at raw/YYYY/MM/DD/{identity}/{date}-turn-{n}-{role}.

test("writeRawEvent writes mirror + evidence at the spec layout", (t) => {
  const root = makeRoot(t);
  const paths = writeRawEvent(baseInput(root));
  const expectedBase = join(
    root,
    "raw",
    "2026",
    "09",
    "28",
    "a".repeat(64),
    "2026-09-28-turn-0-user",
  );
  assert.equal(paths.mirrorPath, `${expectedBase}.md`);
  assert.equal(paths.evidencePath, `${expectedBase}.json`);
  assert.equal(readFileSync(paths.mirrorPath, "utf8"), "hello from the user\n");
});

test("evidence JSON carries redacted text, canary metadata, and a provenance block (spec §11.2)", (t) => {
  const root = makeRoot(t);
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
  const paths = writeRawEvent(baseInput(root, { texts: [`my key is ${secret}`] }));
  const evidence = JSON.parse(readFileSync(paths.evidencePath, "utf8"));
  // mirror is plaintext, evidence is redacted (spec §11.2)
  assert.ok(readFileSync(paths.mirrorPath, "utf8").includes(secret));
  assert.ok(!JSON.stringify(evidence).includes(secret), "evidence must not contain the secret");
  assert.equal(evidence.schemaVersion, 1);
  assert.match(evidence.eventId, /^evt_[0-9a-f]{16}$/);
  assert.deepEqual(evidence.provenance.extractionMethod, "canary-verified");
  assert.ok(evidence.provenance.verifiedBy.includes("cwd-prefix"));
  assert.ok(!evidence.provenance.verifiedBy.includes("cwd-suffix"));
  assert.ok(evidence.provenance.verifiedBy.includes("git-commit"));
  assert.ok(evidence.provenance.verifiedBy.includes("artifact-hash"));
  assert.equal(evidence.provenance.canaryPreserved, true);
  assert.equal(evidence.canaries.artifactPath, "/tmp/agent/memory/artifact-canary.txt");
  assert.equal(evidence.canaries.artifactSha256, "c".repeat(64));
  assert.equal(evidence.canaries.gitCommit, "b".repeat(40));
});

test("eventId is deterministic for identical events and differs across turns/roles", (t) => {
  const root = makeRoot(t);
  const a = JSON.parse(readFileSync(writeRawEvent(baseInput(root)).evidencePath, "utf8"));
  const b = JSON.parse(readFileSync(writeRawEvent(baseInput(root)).evidencePath, "utf8"));
  assert.equal(a.eventId, b.eventId);
  const c = JSON.parse(
    readFileSync(writeRawEvent(baseInput(root, { turnIndex: 1 })).evidencePath, "utf8"),
  );
  assert.notEqual(a.eventId, c.eventId);
});

test("timezone shifts the date folder (spec §5.3 timezone-aware dates)", (t) => {
  const root = makeRoot(t);
  const paths = writeRawEvent(
    baseInput(root, { timezone: "Pacific/Kiritimati", at: new Date("2026-09-28T23:30:00.000Z") }),
  );
  assert.ok(paths.mirrorPath.includes(join("raw", "2026", "09", "29")), "Kiritimati is UTC+14");
});

test("redactSensitive masks common token shapes", () => {
  assert.equal(redactSensitive("key sk-ABCDEFGHIJKLMNOPQRSTUVWX ok"), "key [REDACTED] ok");
  assert.equal(redactSensitive("ghp_0123456789abcdefghijABCDEFGHIJ12"), "[REDACTED]");
  assert.equal(redactSensitive("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
  assert.equal(redactSensitive("nothing secret"), "nothing secret");
});
