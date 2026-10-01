import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { claimDueExtractions, commitExtraction, enqueueExtraction } from "../src/store/jobs.ts";
import { claimConsolidation, commitGeneration, getPublishedGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { MINIMAL_V1_SUMMARY } from "../src/pipeline/validate.ts";
import { acquireEvidencePin, type EvidenceAccess, type EvidenceAccessContext, type EvidenceConsumer, type EvidenceOperation,
  type MemoryReadPin, type ReadValidation } from "../src/read/evidence.ts";
import { renderMemoryCarrier, renderMemorySection, type MemoryCarrierView } from "../src/read/inject.ts";
import { createMemoryTools } from "../src/read/tools.ts";
import {
  ForegroundMemory,
  type ForegroundMemoryHost,
  type ForegroundTimer,
  type PinAcquisition,
} from "../src/read/foreground.ts";

const NOW = Date.UTC(2026, 8, 30);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const messages = (): AgentMessage[] => [
  { role: "system", content: "Foreground policy", timestamp: 0 },
  { role: "user", content: "Current human task", timestamp: 1 },
];
const noAbort = () => { throw new Error("abort must not be called"); };
const carrierOf = (projected: AgentMessage[]) =>
  projected.find(message => message.role === "custom" && message.customType === "pi_memory");

interface ManualHandle { cb: () => void; ms: number; canceled: boolean }
function manualTimer() {
  const handles: ManualHandle[] = [];
  const timer: ForegroundTimer = {
    schedule: (cb, ms) => {
      const handle: ManualHandle = { cb, ms, canceled: false };
      handles.push(handle);
      return handle;
    },
    cancel: handle => { (handle as ManualHandle).canceled = true; },
  };
  // fire executes the callback even after cancellation: a stale callback must be inert.
  return { timer, handles, fire: (index: number) => handles[index]!.cb() };
}

function fakePin(id: string, deadline: number | null = null): MemoryReadPin {
  const formatting: MemoryCarrierView = { memoryVersion: "v1", generationId: id, directory: `/fake/${id}`, controlEpoch: 7,
    manifestHash: `manifest-${id}`, summary: "v1\n## User Profile\nStable preference evidence.\n## What's in Memory\n",
    applicability: [] };
  return Object.freeze({
    memoryVersion: formatting.memoryVersion, generationId: formatting.generationId, controlEpoch: formatting.controlEpoch,
    retentionDeadline: deadline, identity: JSON.stringify([formatting.memoryVersion, formatting.generationId,
      formatting.controlEpoch, formatting.manifestHash]),
    validate: () => ({ valid: true, reason: "valid" }),
    renderCarrier: (cwd: string, budget: Parameters<MemoryReadPin["renderCarrier"]>[1]) => renderMemoryCarrier(formatting, cwd, budget),
    renderSection: (cwd: string) => renderMemorySection(formatting, cwd),
    withEvidence<T>(_context: EvidenceAccessContext, _operation: (access: EvidenceAccess) => EvidenceOperation<T>,
      _consumer?: () => EvidenceConsumer | null): T { throw new Error("test adapter has no evidence store"); },
  });
}

function stubHost() {
  const state = {
    now: 1_000,
    eligible: true,
    invalidFor: null as string | null,
    validation: { valid: true, reason: "valid" } as ReadValidation,
    queue: [] as PinAcquisition[],
    timerInvalidations: 0,
  };
  const clock = manualTimer();
  const host: ForegroundMemoryHost = {
    acquirePin: () => state.queue.shift() ?? { pin: null },
    sampleEligibility: () => state.eligible,
    validatePin: pin => state.invalidFor === pin.generationId ? state.validation : { valid: true, reason: "valid" },
    onTimerInvalidated: () => { state.timerInvalidations++; },
    now: () => state.now,
    timer: clock.timer,
  };
  return { state, clock, host };
}

function beginRun(foreground: ForegroundMemory, cwd = "/workspace"): void {
  foreground.beginRun({ consumerSession: "session", runId: "run", prompt: "task",
    promptOptions: null, cwd, version: "v1", readingAvailable: true });
}

test("a canceled retention callback from a released run cannot erase the new run's output", () => {
  const { state, clock, host } = stubHost();
  const foreground = new ForegroundMemory(host);
  const oldPin = fakePin("old", 2_000);
  state.queue.push({ pin: oldPin });
  beginRun(foreground);
  assert.equal(foreground.pin, oldPin);
  assert.equal(clock.handles.length, 1);
  foreground.settle();
  assert.equal(clock.handles[0]!.canceled, true);
  const newPin = fakePin("new", 4_000);
  state.queue.push({ pin: newPin });
  beginRun(foreground);
  assert.equal(foreground.pin, newPin);
  assert.equal(clock.handles.length, 2);
  clock.fire(0); // stale canceled callback executes deterministically
  assert.equal(foreground.pin, newPin, "stale callback must not invalidate the new run's pin");
  assert.equal(state.timerInvalidations, 0);
  const prepared = foreground.prepareRequest({ messages: messages(), cwd: "/workspace",
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  assert.ok(carrierOf(prepared.messages), "new run still projects its carrier");
  assert.equal(foreground.diagnostic.status, "active");
});

test("retention scheduling samples the current default clock after module construction", t => {
  const { state, clock, host } = stubHost();
  const foreground = new ForegroundMemory({ ...host, now: undefined });
  state.queue.push({ pin: fakePin("current-clock", 2_000) });
  t.mock.method(Date, "now", () => 1_500);
  beginRun(foreground);
  assert.equal(clock.handles[0]!.ms, 500);
  foreground.settle();
});

test("revocation between projection and dispatch strips old evidence; policy, tools and human text survive", () => {
  const { state, host } = stubHost();
  const foreground = new ForegroundMemory(host);
  state.queue.push({ pin: fakePin("revoked") });
  beginRun(foreground);
  const prepared = foreground.prepareRequest({ messages: messages(), cwd: "/workspace",
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  const carrier = carrierOf(prepared.messages);
  assert.ok(carrier && carrier.role === "custom");
  const carrierText = carrier.content as string;
  state.validation = { valid: false, reason: "control_epoch_changed" };
  state.invalidFor = "revoked";
  let aborts = 0;
  const payload = { messages: [
      { role: "system", content: "EXACT_OTHER_POLICY" },
      { role: "user", content: [{ type: "text", text: carrierText }] },
      { role: "user", content: [{ type: "text", text: "REAL_HUMAN" }] }],
    tools: [{ name: "read" }], max_tokens: 1_000 };
  const snapshot = structuredClone(payload);
  const replacement = foreground.admitDispatch({ payload, cwd: "/workspace",
    contextWindow: 200_000, maxTokens: 1_000, abort: () => { aborts++; } }) as typeof payload;
  assert.deepEqual(payload, snapshot, "dispatch fencing never mutates the original payload");
  assert.equal(aborts, 0, "ordinary revocation is not an abort condition");
  assert.equal(JSON.stringify(replacement).includes("Host-provided read guidance"), false);
  assert.equal(JSON.stringify(replacement).includes("REAL_HUMAN"), true);
  assert.equal(replacement.messages[0]!.content, "EXACT_OTHER_POLICY");
  assert.deepEqual(replacement.tools, payload.tools);
  assert.equal(replacement.messages.length, 2);
  assert.equal(foreground.pin, null, "revocation erased the pin synchronously");
});

test("opaque residue at dispatch fails closed and aborts the whole run", () => {
  const { state, host } = stubHost();
  const foreground = new ForegroundMemory(host);
  state.queue.push({ pin: fakePin("opaque") });
  beginRun(foreground);
  const prepared = foreground.prepareRequest({ messages: messages(), cwd: "/workspace",
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  const carrier = carrierOf(prepared.messages);
  assert.ok(carrier && carrier.role === "custom");
  state.validation = { valid: false, reason: "control_epoch_changed" };
  state.invalidFor = "opaque";
  let aborts = 0;
  const result = foreground.admitDispatch({ payload: { opaque: carrier.content as string },
    cwd: "/workspace", contextWindow: 200_000, maxTokens: 1_000, abort: () => { aborts++; } });
  assert.equal(result, undefined, "unsafe residue authorizes no replacement");
  assert.equal(aborts, 1);
  assert.match(foreground.readDiagnostic ?? "", /unsafe_provider_residue/);
  assert.equal(foreground.diagnostic.status, "error");
});

test("budget omission keeps the retrieval pin, the tool grant and later expiry recovery", async () => {
  const { state, host } = stubHost();
  const foreground = new ForegroundMemory(host);
  const pin = fakePin("budget");
  state.queue.push({ pin });
  beginRun(foreground);
  const prepared = foreground.prepareRequest({ messages: messages(), cwd: "/workspace",
    contextWindow: 1, maxTokens: 1_000, abort: noAbort });
  assert.equal(carrierOf(prepared.messages), undefined, "no carrier projected without capacity");
  assert.equal(foreground.pin, pin, "budget omission retains the retrieval pin");
  assert.equal(foreground.diagnostic.representation, "omitted");
  const granted = await foreground.admitToolCall({ preadmitted: true, cwd: "/workspace",
    execute: async () => "tool-output", unavailable: () => "unavailable",
    isIntegrityError: () => false });
  assert.equal(granted, "tool-output", "omission does not revoke the tool grant");
  state.validation = { valid: false, reason: "retention_expired", recoverable: true };
  state.invalidFor = "budget";
  const fresh = fakePin("fresh");
  state.queue.push({ pin: fresh });
  const recovered = foreground.prepareRequest({ messages: messages(), cwd: "/workspace",
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  assert.equal(foreground.pin, fresh, "ordinary expiry recovery still available after omission");
  assert.ok(carrierOf(recovered.messages));
});

// Real store/view fixture: ordinary expiry -> one same-version/same-epoch recovery
// -> old cursor rejected -> second expiry denied.
function storeFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-foreground-"));
  const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  recordSnapshot(db, { workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null,
    cwdReal: root, gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
    session: { sessionKey: "source-session", path: join(root, "session.jsonl"), headerId: "source",
      parentKey: null, branchId: "branch", mode: "tui" }, revision: { sourceId: "source", lineageKey: "lineage",
      revisionHash: "revision", leafId: "user", snapshotPath: join(root, "source.json"), snapshotHash: "snapshot", sourceTime: NOW }, capturedAt: NOW });
  function publish(id: string, empty = false, now = NOW) {
    enqueueExtraction(db, { sourceId: "source", memoryVersion: "v1", promptHash: "extract", now });
    const [job] = claimDueExtractions(db, { owner: "extractor", now, limit: 1 });
    if (job) assert.equal(commitExtraction(db, job, { memoryVersion: "v1", promptHash: "extract",
      model: { provider: "fake", modelId: "fake" }, rawMemory: "decision",
      rolloutSummary: "中文决策\n中文理由\n中文条件\n", rolloutSlug: "decision", outputHash: "output", outcome: "succeeded",
      usage: { input: 1, output: 1 } }, now + 1), true);
    const snapshot = selectConsolidation(db, { memoryVersion: "v1", now: empty ? now + 31 * 86_400_000 : now });
    const lease = claimConsolidation(db, { memoryVersion: "v1", owner: "writer", promptHash: "writer", now: empty ? now + 31 * 86_400_000 : now });
    assert.ok(lease);
    const directory = join(root, "versions", "v1", "generations", id);
    const files: Record<string, string> = { "memory_summary.md": MINIMAL_V1_SUMMARY,
      ...(empty ? {} : { "rollout_summaries/source-decision.md": "中文决策\n中文理由\n中文条件\n" }),
      "MEMORY.md": "handbook" };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true }); writeFileSync(join(directory, path), text);
    }
    const manifest = JSON.stringify({ memoryVersion: "v1", controlEpoch: snapshot.controlEpoch,
      sources: empty ? [] : [{ sourceId: "source", path: "rollout_summaries/source-decision.md" }],
      fileHashes: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, digest(text)])) });
    writeFileSync(join(directory, "manifest.json"), manifest);
    const clock = empty ? now + 31 * 86_400_000 : now;
    assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: "v1", generationId: id,
      directory, manifestHash: digest(manifest), inputHash: id }, now: clock + 2 }), true);
    const view = acquireEvidencePin({ db, root, memoryVersion: "v1", now: clock + 3, extractionPromptHash: "extract" });
    assert.ok(view); return view;
  }
  return { root, db, publish };
}

test("ordinary expiry recovers once at the same version and epoch; old cursor rejected; second expiry denied", async t => {
  const f = storeFixture(t);
  f.publish("old");
  const clock = manualTimer();
  const state = { now: NOW + 4, forced: null as ReadValidation | null, timerInvalidations: 0 };
  const host: ForegroundMemoryHost = {
    acquirePin: (version): PinAcquisition => {
      const options = { maxUnusedDays: 30, extractionPromptHash: "extract" };
      const published = getPublishedGeneration(f.db, version, state.now, options);
      if (!published) return { pin: null, failure: { error: false, reason: "no_eligible_generation" } };
      let failureReason: string = "artifact_integrity";
      const pin = acquireEvidencePin({ db: f.db, root: f.root, memoryVersion: version, now: state.now, ...options,
        onFailure: reason => { failureReason = reason; } });
      if (!pin) return { pin: null, failure: { error: failureReason === "artifact_integrity", reason: failureReason } };
      return { pin };
    },
    sampleEligibility: () => true,
    validatePin: pin => state.forced ?? pin.validate({ db: f.db, root: f.root, maxUnusedDays: 30, now: state.now }),
    onTimerInvalidated: () => { state.timerInvalidations++; },
    now: () => state.now,
    timer: clock.timer,
  };
  const foreground = new ForegroundMemory(host);
  beginRun(foreground, f.root);
  const old = foreground.pin;
  assert.ok(old, "run prepared with the old pin");
  assert.equal(clock.handles.length, 1, "retention timer armed");
  const tools = createMemoryTools({ root: f.root, db: () => f.db as DatabaseSync,
    pin: () => foreground.pin, consumer: () => foreground.activeConsumer, now: () => state.now });
  const search = tools.find(tool => tool.name === "pi_memory_search")!;
  const before = await search.execute("search", { queries: ["中文"], match: "any", maxResults: 1 }, undefined);
  assert.ok(before.details.cursor);
  state.now = NOW + 31 * 86_400_000;
  clock.fire(0);
  assert.equal(foreground.pin, null, "expiry invalidated the pin");
  assert.equal(foreground.diagnostic.reason, "retention_expired");
  assert.equal(state.timerInvalidations, 1);
  f.publish("clean", true); // committed at NOW + 31d, eligible at the current clock
  const prepared = foreground.prepareRequest({ messages: messages(), cwd: f.root,
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  const recoveredPin = foreground.pin as MemoryReadPin | null;
  assert.equal(recoveredPin?.generationId, "clean", "single same-version/same-epoch recovery");
  const carrier = carrierOf(prepared.messages);
  assert.ok(carrier && carrier.role === "custom");
  assert.match(carrier.content as string, /Generation ID: "clean"/);
  const stale = await search.execute("search", { queries: ["中文"], match: "any",
    cursor: before.details.cursor }, undefined);
  assert.equal(stale.details.error, "invalid_cursor", "old generation cursor rejected after recovery");
  state.forced = { valid: false, reason: "retention_expired", recoverable: true };
  const denied = foreground.prepareRequest({ messages: messages(), cwd: f.root,
    contextWindow: 200_000, maxTokens: 1_000, abort: noAbort });
  assert.equal(foreground.pin, null, "second expiry is denied after the single recovery");
  assert.equal(carrierOf(denied.messages), undefined);
  assert.equal(foreground.diagnostic.reason, "retention_expired");
});
