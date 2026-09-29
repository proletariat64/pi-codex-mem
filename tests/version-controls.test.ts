import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { createVersionRun, finishVersionRun, versionRunConfig, setMemoryVersion, setDualWrite } from "../src/control/switch.ts";
import { openStateDb } from "../src/store/db.ts";

test("version and dual-write commands persist only their requested fields and reject invalid values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-version-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = defaultConfig("UTC"); config.generate = false;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  assert.equal(setMemoryVersion(root, "v2").ok, true);
  assert.equal(setDualWrite(root, true).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "config.json"), "utf8")), { ...config, version: "v2", dualWrite: true });
  assert.equal(setMemoryVersion(root, "invalid" as never).ok, false);
  const reopened = loadConfig(root, { create: false }); assert.equal(reopened.status, "ok");
  assert.equal(reopened.config.version, "v2"); assert.equal(reopened.config.generate, false);
});

test("one-run version grants persist policy and target, preserve the selected reader and cancel after a later switch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-version-grant-")); const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = defaultConfig("UTC");
  const grant = createVersionRun(db, config, "v2", 100);
  assert.equal(config.version, "v1");
  assert.equal(versionRunConfig(db, grant, config)!.version, "v2");
  assert.equal(db.prepare("SELECT memory_version FROM version_run_grants WHERE request_id = ?").get(grant.requestId)!.memory_version, "v2");
  assert.equal(versionRunConfig(db, grant, { ...config, dualWrite: true }), null);
  assert.equal(db.prepare("SELECT status FROM version_run_grants WHERE request_id = ?").get(grant.requestId)!.status, "cancelled");
  assert.equal(versionRunConfig(db, grant, config), null, "changing settings back cannot resurrect a cancelled grant");
  const next = createVersionRun(db, config, "v2", 101);
  finishVersionRun(db, next, config);
  assert.equal(versionRunConfig(db, next, config), null);
});

test("explicit policy switches cancel outstanding grants even when settings change back before the next request", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-version-aba-")); const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const config = defaultConfig("UTC"); writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const grant = createVersionRun(db, config, "v2", 100);
  assert.equal(setDualWrite(root, true).ok, true); assert.equal(setDualWrite(root, false).ok, true);
  assert.equal(versionRunConfig(db, grant, config), null);
});
