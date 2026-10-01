import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction } from "../src/store/jobs.ts";
import { claimConsolidation, commitGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";
import { acquireReadView } from "../src/read/view.ts";
import { MemoryRunReader, validateReadView } from "../src/read/run.ts";
import { createMemoryTools } from "../src/read/tools.ts";
import { projectMemoryMessages, hasUnsafeMemoryResidue, removeProviderCarrier, requestCapacity } from "../src/read/projection.ts";

const NOW = Date.UTC(2026, 8, 30);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-local-reader-")); const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  recordSnapshot(db, { workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null,
    cwdReal: root, gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
    session: { sessionKey: "source-session", path: join(root, "session.jsonl"), headerId: "source",
      parentKey: null, branchId: "branch", mode: "tui" }, revision: { sourceId: "source", lineageKey: "lineage",
      revisionHash: "revision", leafId: "user", snapshotPath: join(root, "source.json"), snapshotHash: "snapshot", sourceTime: NOW }, capturedAt: NOW });
  function publish(version: "v1" | "v2", id: string, empty = false, now = NOW) {
    enqueueExtraction(db, { sourceId: "source", memoryVersion: version, promptHash: "extract", now });
    const [job] = claimDueExtractions(db, { owner: "extractor", now, limit: 1 });
    if (job) assert.equal(commitExtraction(db, job, { memoryVersion: version, promptHash: "extract",
      model: { provider: "fake", modelId: "fake" }, rawMemory: version === "v1" ? "decision" : null,
      rolloutSummary: "中文决策\n中文理由\n中文条件\n", rolloutSlug: "decision", outputHash: "output", outcome: "succeeded",
      usage: { input: 1, output: 1 }, ...(version === "v2" ? { truncation: { truncated: false,
        originalBytes: Buffer.byteLength("中文决策\n中文理由\n中文条件\n"), acceptedBytes: Buffer.byteLength("中文决策\n中文理由\n中文条件\n") } } : {}) }, now + 1), true);
    const snapshot = selectConsolidation(db, { memoryVersion: version, now: empty ? now + 31 * 86_400_000 : now });
    const lease = claimConsolidation(db, { memoryVersion: version, owner: "writer", promptHash: "writer", now: empty ? now + 31 * 86_400_000 : now });
    assert.ok(lease);
    const directory = join(root, "versions", version, "generations", id);
    const files: Record<string, string> = { "memory_summary.md": MINIMAL_V1_SUMMARY,
      ...(empty ? {} : { "rollout_summaries/source-decision.md": "中文决策\n中文理由\n中文条件\n" }),
      ...(version === "v1" ? { "MEMORY.md": "handbook" } : {}) };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true }); writeFileSync(join(directory, path), text);
    }
    const manifest = JSON.stringify({ memoryVersion: version, controlEpoch: snapshot.controlEpoch,
      sources: empty ? [] : [{ sourceId: "source", path: "rollout_summaries/source-decision.md" }],
      fileHashes: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, digest(text)])) });
    writeFileSync(join(directory, "manifest.json"), manifest);
    const clock = empty ? now + 31 * 86_400_000 : now;
    assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: version, generationId: id,
      directory, manifestHash: digest(manifest), inputHash: id }, now: clock + 2 }), true);
    const view = acquireReadView({ db, root, memoryVersion: version, now: clock + 3, extractionPromptHash: "extract" });
    assert.ok(view); return view;
  }
  return { root, db, publish };
}

for (const version of ["v1", "v2"] as const) {
  test(`${version}: publication does not switch eligible run pin; integrity is rechecked against pinned artifacts`, t => {
    const f = fixture(t); const old = f.publish(version, "old"); f.publish(version, "new");
    assert.equal(validateReadView(f.db, f.root, old, 30, NOW + 5).valid, true);
    assert.equal(acquireReadView({ db: f.db, root: f.root, memoryVersion: version, generationId: "old", now: NOW + 5 })?.generationId, "old");
    writeFileSync(join(old.directory, "memory_summary.md"), "v1\nchanged");
    const checked = validateReadView(f.db, f.root, old, 30, NOW + 5);
    assert.equal(checked.reason, "artifact_integrity"); assert.equal(checked.error, true); assert.equal(checked.recoverable, undefined);
  });
  test(`${version}: proven ordinary expiry grants one clean same-version recovery, with old cursor rejected`, async t => {
    const f = fixture(t); const old = f.publish(version, "old"); const reader = new MemoryRunReader();
    reader.begin(version, f.root); reader.pin = old;
    let now = NOW + 4;
    const tools = createMemoryTools({ root: f.root, db: () => f.db, view: () => reader.pin, consumer: () => null, now: () => now });
    const search = tools.find(tool => tool.name === "pi_memory_search")!;
    const before = await search.execute("search", { queries: ["中文"], match: "any", maxResults: 1 }, undefined);
    assert.ok(before.details.cursor);
    now = NOW + 31 * 86_400_000;
    const validity = validateReadView(f.db, f.root, old, 30, now);
    assert.equal(validity.reason, "retention_expired"); assert.equal(validity.recoverable, true);
    reader.cache = { key: "old", text: "old secret", representation: "full", reason: "within_budget", counting: "utf8_upper_estimate" };
    reader.invalidate(validity.reason, validity.recoverable);
    assert.equal(reader.cache, null); assert.equal(reader.pin, null);
    const fresh = f.publish(version, "clean", true);
    assert.equal(reader.recover(() => fresh), true); assert.equal(reader.pin, fresh);
    const stale = await search.execute("search", { queries: ["中文"], match: "any", cursor: before.details.cursor }, undefined);
    assert.equal(stale.details.error, "invalid_cursor");
    reader.invalidate("retention_expired", true);
    assert.equal(reader.recover(() => fresh), false); assert.equal(reader.pin, null);
  });
  test(`${version}: cross-process unclassified epoch change never permits recovery or old tool output`, async t => {
    const f = fixture(t); const pin = f.publish(version, "old");
    const external = new DatabaseSync(join(f.root, "state.sqlite"));
    try { external.exec("UPDATE store_state SET control_epoch = control_epoch + 1 WHERE singleton = 1"); } finally { external.close(); }
    assert.equal(validateReadView(f.db, f.root, pin, 30, NOW + 5).reason, "control_epoch_changed");
    const tools = createMemoryTools({ root: f.root, db: () => f.db, view: () => pin, consumer: () => null, now: () => NOW + 5 });
    assert.equal((await tools[0]!.execute("tool", { queries: ["中文"], match: "any" }, undefined)).details.error, "memory_unavailable");
    const reader = new MemoryRunReader(); reader.begin(version, f.root); reader.pin = pin;
    reader.invalidate("control_epoch_changed"); assert.equal(reader.recover(() => pin), false);
  });
  test(`${version}: revocation after reading but before tool return suppresses all output`, async t => {
    const f = fixture(t); const pin = f.publish(version, "old"); let checks = 0;
    const tools = createMemoryTools({ root: f.root, db: () => f.db, view: () => pin, consumer: () => null,
      now: () => {
        if (++checks === 3) f.db.exec("UPDATE store_state SET control_epoch = control_epoch + 1");
        return NOW + 4;
      } });
    const output = await tools[0]!.execute("search", { queries: ["中文"], match: "any" }, undefined);
    assert.equal(output.details.error, "memory_unavailable"); assert.deepEqual(output.details.items, []);
    assert.equal(JSON.stringify(output).includes("中文决策"), false);
  });
  test(`${version}: view refresh timeout is unavailable, not an integrity failure`, t => {
    const f = fixture(t); const pin = f.publish(version, "old");
    const descriptor = Object.getOwnPropertyDescriptor(performance, "now"); let ticks = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => (ticks += 101) });
    try {
      const validation = validateReadView(f.db, f.root, pin, 30, NOW + 4);
      assert.equal(validation.reason, "refresh_timeout"); assert.equal(validation.error, false);
      assert.equal(validation.recoverable, undefined);
    } finally {
      if (descriptor) Object.defineProperty(performance, "now", descriptor);
      else Reflect.deleteProperty(performance, "now");
    }
  });
  test(`${version}: unknown status invalidity is not classified as expiry`, t => {
    const f = fixture(t); const pin = f.publish(version, "old");
    f.db.prepare("UPDATE generations SET status = 'revoked' WHERE generation_id = ?").run(pin.generationId);
    assert.equal(validateReadView(f.db, f.root, pin, 30, NOW + 31 * 86_400_000).recoverable, undefined);
  });
  test(`${version}: budget omission leaves retrieval grant usable without rewriting artifact`, async t => {
    const f = fixture(t); const pin = f.publish(version, "old"); const bytes = readFileSync(join(pin.directory, "memory_summary.md"));
    const reader = new MemoryRunReader(); reader.begin(version, f.root); reader.pin = pin;
    reader.report("disabled", "context_budget", { representation: "omitted" });
    const tools = createMemoryTools({ root: f.root, db: () => f.db, view: () => reader.pin, consumer: () => null, now: () => NOW + 4 });
    assert.equal((await tools.find(tool => tool.name === "pi_memory_read")!.execute("read", { path: "rollout_summaries/source-decision.md" }, undefined)).details.error, undefined);
    assert.deepEqual(readFileSync(join(pin.directory, "memory_summary.md")), bytes);
  });
}

for (const reason of ["user_correction", "user_clear", "source_forgotten", "read_disabled", "session_replaced", "control_epoch_changed"]) {
  test(`${reason}: invalidates pin/cache synchronously without recovery`, () => {
    const reader = new MemoryRunReader(); reader.begin("v1", "/workspace");
    reader.cache = { key: "old", text: "old", representation: "full", reason: "within_budget", counting: "utf8_upper_estimate" };
    reader.invalidate(reason); assert.equal(reader.pin, null); assert.equal(reader.cache, null);
    assert.equal(reader.blocked, true); assert.equal(reader.recover(() => { throw new Error("must not acquire"); }), false);
  });
}

test("request projection preserves canonical system deltas, effective tool changes and tool pairing", () => {
  const messages: AgentMessage[] = [ { role: "system", content: "policy", timestamp: 0 },
    { role: "user", content: "question", timestamp: 1 },
    { role: "system", content: "delta", timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      api: "openai-completions", provider: "fake", model: "fake", stopReason: "toolUse", timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 4 } ];
  const snapshot = structuredClone(messages); const projected = projectMemoryMessages(messages, "memory");
  assert.deepEqual(messages, snapshot); assert.notEqual(messages, projected);
  assert.equal(projected[0], messages[0]); assert.equal(projected[1]!.role, "custom");
  assert.deepEqual(projected.slice(2), messages.slice(1));
  assert.equal(projectMemoryMessages(projected, "new").filter(message => message.role === "custom").length, 1);
  assert.equal(projectMemoryMessages(messages.slice(1), "memory")[0]!.role, "custom");
});

test("ambiguous legacy system residue is unsafe; owned custom leftovers removable", () => {
  const content = "## Pi Memory\nMemory version: v1\n<historical_memory_evidence>old</historical_memory_evidence>";
  assert.equal(hasUnsafeMemoryResidue([{ role: "system", content, timestamp: 0 }]), true);
  const custom: AgentMessage = { role: "custom", customType: "pi_memory", content, display: false, timestamp: 0 };
  assert.equal(hasUnsafeMemoryResidue([custom]), false); assert.deepEqual(projectMemoryMessages([custom], null), []);
  const ownedSection: AgentMessage = { role: "system", content: "", sections: { policy: "keep", pi_memory: content }, timestamp: 0 };
  const snapshot = structuredClone(ownedSection);
  const cleaned = projectMemoryMessages([ownedSection], null);
  assert.deepEqual(ownedSection, snapshot);
  assert.equal(hasUnsafeMemoryResidue(cleaned), false);
  const cleanedHead = cleaned[0];
  assert.ok(cleanedHead && cleanedHead.role === "system");
  assert.deepEqual(cleanedHead.sections, { policy: "keep" });
  assert.equal(hasUnsafeMemoryResidue([{ role: "system", content: "", sections: { other: content }, timestamp: 0 }]), true);
});

test("provider replacement removes only attributable whole user carrier; merged/unknown residue fails closed", () => {
  const text = "## Pi Memory\nMemory version: v1\n<historical_memory_evidence>owned</historical_memory_evidence>";
  const fingerprints = new Set([digest(text)]);
  for (const key of ["messages", "input"]) {
    const payload = { [key]: [{ role: "user", content: [{ type: key === "input" ? "input_text" : "text", text }] },
      { role: "assistant", content: "quotation remains" }, { role: "user", content: "human" }], tools: [{ name: "read" }] };
    const frozen = structuredClone(payload); const replacement = removeProviderCarrier(payload, fingerprints);
    assert.equal(replacement.safe, true); assert.equal(replacement.removed, 1); assert.deepEqual(payload, frozen);
    assert.deepEqual((replacement.payload as typeof payload).tools, payload.tools);
  }
  assert.equal(removeProviderCarrier({ messages: [{ role: "user", content: `human\n${text}` }] }, fingerprints).safe, false);
  assert.equal(removeProviderCarrier({ unknown: text }, fingerprints).safe, false);
  const gemini = removeProviderCarrier({ contents: [{ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: "answer" }] }] }, fingerprints);
  assert.equal(gemini.safe, true); assert.equal(gemini.removed, 1);
});

test("remaining input capacity accounts for entire non-memory request and output reservation", () => {
  const messages: AgentMessage[] = [{ role: "system", content: "policy", timestamp: 0 }, { role: "user", content: "中文", timestamp: 1 }];
  assert.equal(requestCapacity(messages, 10_000, 2_000), 10_000 - 2_000 - 1024 - Buffer.byteLength(JSON.stringify(messages)));
  assert.equal(requestCapacity(messages, 100, 2_000), 0); assert.equal(requestCapacity(messages, undefined, 2_000), null);
  assert.equal(requestCapacity(messages, 10_000, undefined), null);
});

test("capacity reserves effective tool envelopes beyond the fixed request reserve", () => {
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: "中文 schema ".repeat(20), parameters: Type.Object({ input: Type.String() }) }));
  const messages: AgentMessage[] = [{ role: "system", content: "policy", toolsAdded: tools, timestamp: 0 }];
  const rawOnly = 100_000 - 2_000 - 1024 - Buffer.byteLength(JSON.stringify(messages));
  assert.equal(requestCapacity(messages, 100_000, 2_000), rawOnly - Buffer.byteLength(JSON.stringify(tools)) - tools.length * 256);
  const removed: AgentMessage[] = [...messages, { role: "system", content: "", toolsRemoved: tools.map(({ name }) => ({ name })), timestamp: 1 }];
  assert.equal(requestCapacity(removed, 100_000, 2_000), 100_000 - 2_000 - 1024 - Buffer.byteLength(JSON.stringify(removed)));
});

test("warning counters deduplicate within run, then count next run; release clears model-visible cache", () => {
  const reader = new MemoryRunReader(); reader.begin("v1", "/workspace");
  reader.report("disabled", "context_budget"); reader.report("disabled", "context_budget");
  assert.equal(reader.diagnostic.warningCounts.context_budget, 1);
  reader.begin("v1", "/workspace"); reader.report("disabled", "context_budget");
  assert.equal(reader.diagnostic.warningCounts.context_budget, 2); reader.release();
  assert.equal(reader.pin, null); assert.equal(reader.cache, null); assert.equal(reader.version, null);
});
