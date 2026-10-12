import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.ts";
import { openStateDb, recordSnapshot } from "../src/store/db.ts";
import { enqueueExtraction, claimDueExtractions, commitExtraction } from "../src/store/jobs.ts";
import { selectConsolidation, claimConsolidation } from "../src/store/consolidation.ts";
import { prepareGenerationCandidate } from "../src/pipeline/candidate.ts";
import { consolidationPromptHash } from "../src/pipeline/consolidate.ts";
import { persistentDiagnostics } from "../src/diagnostics.ts";
import { acquireEvidencePin } from "../src/read/evidence.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { v2PromptHash } from "../src/extraction/v2.ts";

for (const version of ["v1", "v2"] as const) test(`${version}: native Writer publishes all 256 selected sources and exposes READABLE retrieval`, async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-writer-publication-"));
  const db = openStateDb(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const now = Date.now();
  const config = { ...defaultConfig("UTC"), version };
  const extractionHash = version === "v1" ? v1PromptHash() : v2PromptHash();
  const rolloutSummary = "Keep source-specific evidence. ".repeat(55);
  for (let i = 0; i < 256; i++) {
    const id = `source-${i}`;
    recordSnapshot(db, {
      workspace: { workspaceKey: "workspace", repoKey: null, checkoutKey: null, cwdReal: root,
        gitCommonDir: null, gitTopLevel: null, gitBranch: null, gitHead: null },
      session: { sessionKey: `session-${i}`, path: `synthetic-${i}.jsonl`, headerId: id, parentKey: null, branchId: "branch", mode: "tui" },
      revision: { sourceId: id, lineageKey: id, revisionHash: id, leafId: id,
        snapshotPath: `synthetic-${i}.json`, snapshotHash: id, sourceTime: now - 1000 }, capturedAt: now - 1000,
    });
    enqueueExtraction(db, { sourceId: id, memoryVersion: version, promptHash: extractionHash, now });
    const [job] = claimDueExtractions(db, { owner: "fixture", now, limit: 1 }); assert.ok(job);
    assert.equal(commitExtraction(db, job, { memoryVersion: version, promptHash: extractionHash,
      model: { provider: "fixture", modelId: "model" }, rawMemory: version === "v1" ? "Supported learning." : null,
      rolloutSummary, rolloutSlug: id, outputHash: id, usage: { input: 1, output: 1 }, outcome: "succeeded",
      ...(version === "v2" ? { truncation: { truncated: false, originalBytes: Buffer.byteLength(rolloutSummary), acceptedBytes: Buffer.byteLength(rolloutSummary) } } : {}),
    }, now), true);
  }
  const snapshot = selectConsolidation(db, { memoryVersion: version, now, extractionPromptHash: extractionHash,
    maxSources: 256, maxUnusedDays: config.schedule.maxUnusedDays });
  assert.equal(snapshot.sources.length, 256);
  const lease = claimConsolidation(db, { memoryVersion: version, owner: "writer", now,
    promptHash: consolidationPromptHash(config, version) }); assert.ok(lease);
  const candidate = prepareGenerationCandidate({ db, root, lease, snapshot, config,
    signal: new AbortController().signal, clock: () => now });
  t.after(() => candidate.dispose());
  const staging = join(root, "versions", version, "staging", `${lease.jobId}-${lease.fence}`);
  const manifest = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8"));
  const paths = manifest.sources.map((source: { path: string }) => source.path) as string[];
  assert.equal(paths.length, 256);
  const model: Model<Api> = { id: "writer", name: "Writer", api: "openai-completions", provider: "fixture",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 8_000 };
  const summary = "v1\n## User Profile\n## User preferences\n## General Tips\n## What's in Memory\n- Supported route: " + paths[0];
  let requests = 0;
  const result = await candidate.runWriter({ modelRef: { provider: model.provider, modelId: model.id }, port: {
    resolve: () => model,
    stream: (_model, context) => {
      requests++;
      if (requests === 2) {
        const reads = context.messages.filter(message => message.role === "toolResult" && message.toolName === "workspace_read");
        assert.equal(reads.length, 257);
        assert.ok(Buffer.byteLength(JSON.stringify(context)) > 404_000, "actual normalized request exercises former byte/token regression");
        assert.equal(reads.some(message => message.role === "toolResult" && message.isError), false);
      }
      const content: AssistantMessage["content"] = requests === 1 ? [
        { type: "toolCall", id: "diff", name: "workspace_read", arguments: { path: "phase2_workspace_diff.md" } },
        ...paths.map((path, i) => ({ type: "toolCall" as const, id: `read-${i}`, name: "workspace_read", arguments: { path } })),
      ] : requests === 2 ? [
        ...(version === "v1" ? [{ type: "toolCall" as const, id: "handbook", name: "workspace_write", arguments: { path: "MEMORY.md", content: "Supported learning." } }] : []),
        { type: "toolCall", id: "summary", name: "workspace_write", arguments: { path: "memory_summary.md", content: summary } },
      ] : [{ type: "text", text: "Complete." }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        stopReason: requests <= 2 ? "toolUse" : "stop", timestamp: now,
        usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: requests <= 2 ? "toolUse" : "stop", message });
      return stream;
    },
  } });
  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(requests, 3);
  assert.equal(candidate.publish(), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_sources").get()!.n, 256);
  assert.equal(persistentDiagnostics(db, config, now).selectedReadable, true);
  const pin = acquireEvidencePin({ db, root, memoryVersion: version, now, extractionPromptHash: extractionHash });
  assert.ok(pin);
  assert.match(pin.renderSection(root), /Supported route/);
  const evidence = pin.withEvidence({ root, db: () => db, now: () => now,
    maxUnusedDays: () => config.schedule.maxUnusedDays }, access => {
    const contents = access.read(paths[0]!);
    return { complete: () => contents };
  });
  assert.match(JSON.stringify(evidence), /source-specific evidence/);
});
