import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction } from "../src/store/jobs.ts";
import { claimConsolidation, commitGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { evidencePath, textHash } from "../src/pipeline/staging.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";
import { acquireReadView } from "../src/read/view.ts";
import { createMemoryTools } from "../src/read/tools.ts";

const NOW = Date.UTC(2026, 8, 29);
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-retrieval-"));
  const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  recordSnapshot(db, {
    workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
      gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
    session: { sessionKey: "source-session", path: join(root, "source.jsonl"), headerId: "source",
      parentKey: null, branchId: "branch", mode: "tui" },
    revision: { sourceId: "source", lineageKey: "lineage", revisionHash: "revision", leafId: "u1",
      snapshotPath: join(root, "snapshot.json"), snapshotHash: "snapshot", sourceTime: NOW - 86_400_000 },
    capturedAt: NOW,
  });
  function publish(version: "v1" | "v2", id = `generation-${version}`, text = "中文决策\nTypeScript chosen\n中文理由\n", handbook?: string) {
    enqueueExtraction(db, { sourceId: "source", memoryVersion: version, promptHash: "extract", now: NOW });
    const [job] = claimDueExtractions(db, { owner: "extractor", now: NOW, limit: 1 });
    if (job) assert.equal(commitExtraction(db, job, { memoryVersion: version, promptHash: "extract",
      model: { provider: "fixture", modelId: "extract" }, rawMemory: version === "v1" ? text : null,
      rolloutSummary: text, rolloutSlug: "decision", outputHash: textHash(text), outcome: "succeeded",
      usage: { input: 1, output: 1 }, ...(version === "v2" ? { truncation: { truncated: false,
        originalBytes: Buffer.byteLength(text), acceptedBytes: Buffer.byteLength(text) } } : {}) }, NOW + 1), true);
    const snapshot = selectConsolidation(db, { memoryVersion: version, now: NOW + 2 });
    const lease = claimConsolidation(db, { memoryVersion: version, owner: "writer", promptHash: "writer", now: NOW + 2 });
    assert.ok(lease);
    const directory = join(root, "versions", version, "generations", id);
    const path = evidencePath("source", "decision");
    const files: Record<string, string> = { "memory_summary.md": MINIMAL_V1_SUMMARY, [path]: text,
      "notes/private.md": "private note", "raw_memories.md": "private raw", "phase2_workspace_diff.md": "private diff" };
    if (version === "v1") {
      files["MEMORY.md"] = handbook ?? `# Decision\n中文决策 ${path}\n`;
      files["skills/types/SKILL.md"] = `# Procedure\nSee ${path}\n`;
    }
    for (const [name, content] of Object.entries(files)) {
      const target = join(directory, name); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content);
    }
    const manifest = JSON.stringify({ memoryVersion: version, controlEpoch: snapshot.controlEpoch,
      sources: [{ sourceId: "source", path }], fileHashes: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, textHash(content)])) });
    writeFileSync(join(directory, "manifest.json"), manifest);
    assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: version, generationId: id,
      directory, inputHash: id, manifestHash: createHash("sha256").update(manifest).digest("hex") }, now: NOW + 3 }), true);
    const view = acquireReadView({ db, root, memoryVersion: version, now: NOW + 4 }); assert.ok(view);
    const tools = createMemoryTools({ root, db: () => db, view: () => view,
      consumer: () => ({ consumerSession: "reader", runId: "run" }), now: () => NOW + 5 });
    const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === `pi_memory_${name}`)!
      .execute("call", args, undefined);
    return { view, path, call, directory };
  }
  return { root, db, publish };
}

test("literal Chinese search returns pinned evidence with deterministic paging and no usage", async (t) => {
  const { db, publish } = fixture(t); const { call, path } = publish("v1");
  const first = await call("search", { queries: ["中文"], match: "any", maxResults: 1 });
  assert.equal(first.details.memoryVersion, "v1");
  assert.equal(first.details.generationId, "generation-v1");
  assert.equal(first.details.items[0]!.path, "MEMORY.md");
  assert.equal(first.details.truncated, true);
  const next = await call("search", { queries: ["中文"], match: "any", cursor: first.details.cursor });
  assert.deepEqual(next.details.items.map((item: { path: string; startLine: number }) => [item.path, item.startLine]), [[path, 1], [path, 3]]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 0);
});

test("missing original transcripts keep extracted memory readable with an unavailable-source marker", async (t) => {
  const { root, db, publish } = fixture(t);
  const original = join(root, "source.jsonl"); writeFileSync(original, '{"original":"evidence"}\n');
  const { call, view, path } = publish("v1");
  assert.equal((await call("read", { path })).details.items[0]!.sourceUnavailable, undefined);
  unlinkSync(original);
  const read = await call("read", { path });
  assert.equal(read.details.error, undefined); assert.equal(read.details.items[0]!.sourceUnavailable, true);
  assert.match(read.details.items[0]!.content!, /中文决策/);
  assert.equal(acquireReadView({ root, db, memoryVersion: "v1", now: NOW + 6 })!.generationId, view.generationId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM suppression_tombstones").get()!.n, 0);
});

test("v2 reads rollout evidence only and successful detail reads deduplicate versioned usage", async (t) => {
  const { db, publish } = fixture(t); const v1 = publish("v1"); const v2 = publish("v2");
  const listed = await v2.call("list", {});
  assert.deepEqual(listed.details.items.map(item => item.path), [v2.path]);
  for (const path of ["MEMORY.md", "memory_summary.md", "skills/types/SKILL.md", "manifest.json", "notes/private.md",
    "raw_memories.md", "phase2_workspace_diff.md", "../v1/MEMORY.md", "/etc/passwd", "versions/v1/MEMORY.md"]) {
    for (const name of ["read", "list", "search"]) {
      const denied = await v2.call(name, { path, queries: ["private"], match: "any" });
      assert.equal(denied.details.error, "path_not_available_for_version", `${name}: ${path}`);
      assert.deepEqual(denied.details.items, []);
    }
  }
  const detail = await v2.call("read", { path: v2.path, startLine: 2, maxLines: 1 });
  assert.equal(detail.details.items[0]!.content, "TypeScript chosen");
  assert.deepEqual(detail.details.items[0]!.sourceIds, ["source"]);
  assert.equal(detail.details.items[0]!.startLine, 2);
  await v2.call("read", { path: v2.path });
  await v2.call("read", { path: v2.path, startLine: 999 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 1);
  await v1.call("read", { path: "MEMORY.md" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 2);
  assert.equal((await v1.call("read", { path: "skills/types/SKILL.md" })).details.error, undefined);
});

test("T33 cross: version and generation mismatched cursors cannot serve content", async (t) => {
  const { publish } = fixture(t); const first = publish("v1");
  const search = { queries: ["中文"], match: "any", maxResults: 1 };
  const cursor = (await first.call("search", search)).details.cursor;
  assert.ok(cursor);
  const other = publish("v2"); const newer = publish("v1", "new-v1");
  for (const [call, args] of [[other.call, search], [newer.call, search], [first.call, { ...search, queries: ["TypeScript"] }],
    [first.call, { ...search, path: first.path }], [first.call, { ...search, match: "all" }],
    [first.call, { ...search, caseSensitive: false }]] as const) {
    assert.equal((await call("search", { ...args, cursor })).details.error, "invalid_cursor");
  }
  assert.equal((await first.call("list", { cursor })).details.error, "invalid_cursor");
  assert.equal((await first.call("search", { ...search, cursor: "invalid" })).details.error, "invalid_cursor");
  assert.equal((await first.call("search", { ...search, memoryVersion: "v2" })).details.error, "invalid_arguments");
  assert.equal((await first.call("read", { path: first.path })).details.generationId, "generation-v1",
    "ordinary publication does not change the run's immutable pin");
});

test("literal case folding is opt-in and all matching requires every query on the line", async (t) => {
  const { publish } = fixture(t); const { call, path } = publish("v2");
  assert.equal((await call("search", { queries: ["typescript"], match: "any" })).details.items.length, 0);
  assert.equal((await call("search", { queries: ["typescript", "chosen"], match: "all", caseSensitive: false })).details.items[0]!.startLine, 2);
  assert.equal((await call("search", { queries: ["中文", "chosen"], match: "all" })).details.items.length, 0);
  assert.equal((await call("search", { queries: [".*"], match: "any", path })).details.items.length, 0);
});

test("all tools reject revoked, expired, symlinked and tampered pinned evidence without content", async (t) => {
  const { db, root, publish } = fixture(t); const { call, path, directory } = publish("v1");
  const target = join(directory, path);
  unlinkSync(target); symlinkSync(join(root, "state.sqlite"), target);
  assert.equal((await call("read", { path })).details.error, "memory_unavailable");
  unlinkSync(target); writeFileSync(target, "tampered private contents");
  assert.equal((await call("search", { queries: ["tampered"], match: "any" })).details.error, "memory_unavailable");
  writeFileSync(target, "中文决策\nTypeScript chosen\n中文理由\n");
  db.prepare("UPDATE source_revisions SET source_time = ?").run(NOW - 31 * 86_400_000);
  assert.equal((await call("read", { path })).details.error, "memory_unavailable");
  db.prepare("UPDATE source_revisions SET source_time = ?").run(NOW);
  db.exec("UPDATE store_state SET control_epoch = control_epoch + 1; UPDATE pipeline_state SET read_blocked = 1;");
  for (const name of ["read", "search", "list"]) {
    const output = await call(name, { path, queries: ["中文"], match: "any" });
    assert.equal(output.details.error, "memory_unavailable"); assert.deepEqual(output.details.items, []);
  }
});

test("responses stay within 16 KiB including details and expose continuation and long-line truncation", async (t) => {
  const { publish } = fixture(t); const { call, path } = publish("v1", "large", `${"中文".repeat(5_000)}\n${"中文\n".repeat(200)}`);
  const first = await call("read", { path, maxLines: 300 });
  assert.equal(first.details.truncated, true); assert.ok(first.details.nextStartLine);
  assert.equal(first.details.items[0]!.truncated, true);
  assert.ok(!first.details.items[0]!.content!.includes("�"));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16_384);
  let cursor: string | null = null; let found = 0;
  do {
    const output = await call("search", { queries: ["中文"], path, match: "any", maxResults: 50, ...(cursor ? { cursor } : {}) });
    assert.equal(output.details.error, undefined); assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16_384);
    found += output.details.items.length; cursor = output.details.cursor;
  } while (cursor);
  assert.equal(found, 201);
});

test("a pinned manifest hash cannot be replaced even when the database hash changes", async (t) => {
  const { db, publish } = fixture(t); const { call, directory, path } = publish("v1");
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(join(directory, path), "replaced pinned content");
  manifest.fileHashes[path] = textHash("replaced pinned content");
  const bytes = JSON.stringify(manifest); writeFileSync(manifestPath, bytes);
  db.prepare("UPDATE generations SET manifest_hash = ? WHERE generation_id = 'generation-v1'").run(textHash(bytes));
  assert.equal((await call("read", { path })).details.error, "memory_unavailable");
});

test("JSON escape expansion still yields truncated evidence instead of losing the response", async (t) => {
  const { publish } = fixture(t); const { call, path } = publish("v1", "escaped", `中文${"\u0000".repeat(6_000)}\n中文next`);
  for (const name of ["read", "search"]) {
    const output = await call(name, { path, queries: ["中文"], match: "any" });
    assert.equal(output.details.error, undefined); assert.ok(output.details.items.length);
    assert.equal(output.details.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16_384);
  }
});

test("a handbook lesson read counts its task-local sources even when references are outside the requested page", async (t) => {
  const { db, publish } = fixture(t);
  const handbook = `# Task Group: Types\nscope: project\napplies_to: repo\n## Task 1: Choice\n### rollout_summary_files\n- ${evidencePath("source", "decision")}\n### learnings\n- 中文决策\n## Task 2: Explicit note\n### rollout_summary_files\n- notes/private.md\n### learnings\n- Note-only lesson\n`;
  const { call } = publish("v1", "task-attribution", "中文决策", handbook);
  const detail = await call("read", { path: "MEMORY.md", startLine: 8, maxLines: 1 });
  assert.deepEqual(detail.details.items[0]!.sourceIds, ["source"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 1);
  const noteOnly = await call("read", { path: "MEMORY.md", startLine: 13, maxLines: 1 });
  assert.deepEqual(noteOnly.details.items[0]!.sourceIds, [], "an unrelated task's sources must not be refreshed");
});

test("a 128-source task keeps metadata bounded and records complete validated detail support", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-many-sources-")); const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const ids = Array.from({ length: 128 }, (_, index) => index.toString(16).padStart(64, "0"));
  for (const sourceId of ids) {
    writeFileSync(join(root, `${sourceId}.jsonl`), '{"original":"available"}\n');
    recordSnapshot(db, {
      workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
        gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
      session: { sessionKey: sourceId, path: join(root, `${sourceId}.jsonl`), headerId: sourceId,
        parentKey: null, branchId: "branch", mode: "tui" },
      revision: { sourceId, lineageKey: sourceId, revisionHash: "revision", leafId: "u1",
        snapshotPath: join(root, `${sourceId}.json`), snapshotHash: "snapshot", sourceTime: NOW }, capturedAt: NOW,
    });
    enqueueExtraction(db, { sourceId, memoryVersion: "v1", promptHash: "extract", now: NOW });
    const [job] = claimDueExtractions(db, { owner: "extractor", now: NOW, limit: 1 }); assert.ok(job);
    assert.equal(commitExtraction(db, job, { memoryVersion: "v1", promptHash: "extract",
      model: { provider: "fixture", modelId: "extract" }, rawMemory: "text", rolloutSummary: "text",
      rolloutSlug: "decision", outputHash: textHash("text"), outcome: "succeeded", usage: { input: 1, output: 1 } }, NOW + 1), true);
  }
  const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: NOW + 2 });
  const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "writer", now: NOW + 2 }); assert.ok(lease);
  const directory = join(root, "versions/v1/generations/many");
  const sourcePaths = ids.map(id => evidencePath(id, "decision"));
  const handbook = `# Task Group: Types\nscope: project\napplies_to: repo\n## Task 1: Choice\n### rollout_summary_files\n${sourcePaths.map(path => `- ${path}`).join("\n")}\n### keywords\n- TypeScript\n### learnings\n- TypeScript chosen\n`;
  const files = { "memory_summary.md": MINIMAL_V1_SUMMARY, "MEMORY.md": handbook,
    ...Object.fromEntries(sourcePaths.map(path => [path, "text"])) };
  for (const [name, text] of Object.entries(files)) {
    const target = join(directory, name); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text);
  }
  const manifest = JSON.stringify({ memoryVersion: "v1", controlEpoch: snapshot.controlEpoch,
    sources: ids.map((sourceId, index) => ({ sourceId, path: sourcePaths[index] })),
    fileHashes: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, textHash(text)])) });
  writeFileSync(join(directory, "manifest.json"), manifest);
  assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: "v1", generationId: "many",
    directory, inputHash: "many", manifestHash: textHash(manifest) }, now: NOW + 3 }), true);
  const view = acquireReadView({ db, root, memoryVersion: "v1", now: NOW + 4 }); assert.ok(view);
  const tools = createMemoryTools({ root, db: () => db, view: () => view,
    consumer: () => ({ consumerSession: "reader", runId: "run" }), now: () => NOW + 5 });
  unlinkSync(join(root, `${ids[12]}.jsonl`));
  for (const name of ["read", "list", "search"]) {
    const output = await tools.find(tool => tool.name === `pi_memory_${name}`)!.execute("call",
      { path: "MEMORY.md", startLine: 4, maxLines: 1, queries: ["Task Group"], match: "any" }, undefined);
    assert.equal(output.details.error, undefined); assert.equal(output.details.truncated, true);
    assert.equal(output.details.items[0]!.omittedSourceIds, 116);
    assert.deepEqual(output.details.items[0]!.sourceIds, ids.slice(0, 12));
    assert.equal(output.details.items[0]!.sourceUnavailable, true, "omitted attribution still participates in source availability");
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16_384);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_usage").get()!.n, 128);
});
