import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, updateConfig, validateConfig } from "../src/config.ts";

function makeRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("first load creates config.json with spec defaults", (t) => {
  const root = makeRoot(t);
  const result = loadConfig(root, { timezone: "Asia/Shanghai" });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  const c = result.config;
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.enabled, true);
  assert.equal(c.read, true);
  assert.equal(c.generate, true);
  assert.equal(c.version, "v1");
  assert.equal(c.dualWrite, false);
  assert.deepEqual(c.captureModes, ["tui"]);
  assert.deepEqual(c.models, { extract: null, consolidate: null });
  assert.equal(c.schedule.minIdleMinutes, 360);
  assert.equal(c.schedule.maxSourceAgeDays, 10);
  assert.equal(c.schedule.maxExtractionsPerPass, 2);
  assert.equal(c.schedule.extractionConcurrency, 2);
  assert.equal(c.schedule.maxConsolidationSources, 256);
  assert.equal(c.schedule.maxUnusedDays, 30);
  assert.equal(c.limits.summaryBytes, 9999);
  assert.equal(c.limits.v2RolloutSummaryBytes, 9000);
  assert.equal(c.limits.dailyRequests, 20);
  assert.equal(c.timezone, "Asia/Shanghai");
  // The file was actually written
  const onDisk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  assert.equal(onDisk.schemaVersion, 1);
});

test("second load returns ok with persisted values", (t) => {
  const root = makeRoot(t);
  const first = loadConfig(root, { timezone: "UTC" });
  assert.equal(first.status, "created");
  const second = loadConfig(root, { timezone: "UTC" });
  assert.equal(second.status, "ok");
  if (second.status === "ok") assert.deepEqual(second.config, defaultConfig("UTC"));
});

test("invalid ranges produce an invalid result and preserve the file", (t) => {
  const root = makeRoot(t);
  const path = join(root, "config.json");
  const bad = { ...defaultConfig("UTC"), limits: { ...defaultConfig("UTC").limits, summaryBytes: 100000 } };
  const original = JSON.stringify(bad, null, 2);
  writeFileSync(path, original);
  const result = loadConfig(root);
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.ok(result.problems.some((p) => p.includes("summaryBytes")));
  // File preserved byte-for-byte (spec §14: do not overwrite)
  assert.equal(readFileSync(path, "utf8"), original);
});

test("v2 caps cannot be raised via configuration", (t) => {
  const root = makeRoot(t);
  const bad = defaultConfig("UTC");
  bad.limits.v2RolloutSummaryBytes = 12000;
  writeFileSync(join(root, "config.json"), JSON.stringify(bad));
  const result = loadConfig(root);
  assert.equal(result.status, "invalid");
});

test("unknown schemaVersion is rejected, not migrated in place", (t) => {
  const root = makeRoot(t);
  const raw = { ...defaultConfig("UTC"), schemaVersion: 99 };
  writeFileSync(join(root, "config.json"), JSON.stringify(raw));
  const result = loadConfig(root);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.ok(result.problems.some((p) => p.includes("schemaVersion")));
  }
});

test("malformed JSON preserves the file and reports invalid", (t) => {
  const root = makeRoot(t);
  const path = join(root, "config.json");
  writeFileSync(path, "{ not json");
  const result = loadConfig(root);
  assert.equal(result.status, "invalid");
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("enabled=false is distinguished from generate=false,read=true", () => {
  const off = { ...defaultConfig("UTC"), enabled: false };
  const readOnly = { ...defaultConfig("UTC"), generate: false, read: true };
  assert.deepEqual(validateConfig(off), []);
  assert.deepEqual(validateConfig(readOnly), []);
  assert.notEqual(off.enabled, readOnly.enabled);
  assert.notEqual(off.generate, readOnly.generate);
});

test("updateConfig applies a mutation and persists it atomically", (t) => {
  const root = makeRoot(t);
  loadConfig(root, { timezone: "UTC" });
  const result = updateConfig(root, (c) => ({ ...c, version: "v2" as const }));
  assert.equal(result.ok, true);
  const reloaded = loadConfig(root);
  assert.equal(reloaded.status, "ok");
  if (reloaded.status === "ok") assert.equal(reloaded.config.version, "v2");
});

test("updateConfig refuses a mutation that would violate ranges", (t) => {
  const root = makeRoot(t);
  loadConfig(root, { timezone: "UTC" });
  const result = updateConfig(root, (c) => ({
    ...c,
    limits: { ...c.limits, summaryBytes: 10 },
  }));
  assert.equal(result.ok, false);
  // File still holds the previous valid config
  const reloaded = loadConfig(root);
  assert.equal(reloaded.status, "ok");
});

test("loadConfig with create:false reports missing without writing", (t) => {
  const root = makeRoot(t);
  const result = loadConfig(root, { create: false });
  assert.equal(result.status, "missing");
  assert.throws(() => readFileSync(join(root, "config.json")));
});

test("sequential updates both apply and leave no tmp or lock litter", (t) => {
  const root = makeRoot(t);
  loadConfig(root, { timezone: "UTC" });
  assert.equal(updateConfig(root, (c) => ({ ...c, version: "v2" as const })).ok, true);
  assert.equal(updateConfig(root, (c) => ({ ...c, dualWrite: true })).ok, true);
  const reloaded = loadConfig(root);
  assert.equal(reloaded.status, "ok");
  if (reloaded.status === "ok") {
    assert.equal(reloaded.config.version, "v2");
    assert.equal(reloaded.config.dualWrite, true);
  }
  const leftovers = readdirSync(root).filter((f) => f.includes(".tmp") || f.includes(".lock") || f.includes(".stale"));
  assert.deepEqual(leftovers, []);
});
