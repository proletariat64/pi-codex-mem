import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { GENERATION_PIN_TTL_MS, openStateDb } from "../src/store/db.ts";
import { claimConsolidation, commitGeneration, selectConsolidation } from "../src/store/consolidation.ts";
import { cleanupGenerations } from "../src/pipeline/publish.ts";
import { makeMockPi, projectRequest } from "./mock-pi.ts";

for (const metadata of ["persistent", "ephemeral", "unavailable"] as const) {
  test(`${metadata}: first-run heartbeat preserves a lazily acquired pin through cleanup and stops at settlement/shutdown`, { timeout: 60_000 }, async t => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-memory-pin-heartbeat-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const root = join(agentDir, "memory");
    mkdirSync(root);
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...defaultConfig("UTC"), generate: false }));
    let now = Date.UTC(2026, 9, 2);
    t.mock.method(Date, "now", () => now);
    const intervals = new Map<NodeJS.Timeout, () => void>();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
      assert.equal(delay, 30_000);
      const timer = originalSetInterval(callback, 2_147_483_647);
      intervals.set(timer, callback);
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (timer: NodeJS.Timeout) => {
      intervals.delete(timer);
      originalClearInterval(timer);
    });
    const mock = makeMockPi();
    const ctx = {
      cwd: process.cwd(), hasUI: false,
      model: { provider: "mock", id: "memory", contextWindow: 200_000, maxTokens: 8_000 },
      modelRegistry: { find: () => undefined, streamSimple: () => undefined },
      sessionManager: {
        getBranch: () => [], getLeafId: () => null,
        getHeader: () => {
          if (metadata === "unavailable") throw new Error("metadata unavailable");
          return metadata === "persistent" ? { id: "pin-session" } : null;
        },
        getSessionFile: () => metadata === "persistent" ? join(agentDir, "session.jsonl") : undefined,
      },
    };
    t.after(async () => {
      await mock.fire("session_shutdown", {}, ctx);
      for (const timer of intervals.keys()) originalClearInterval(timer);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(agentDir, { recursive: true, force: true });
    });
    extension(mock.pi);
    await mock.fire("session_start", {}, ctx);
    // Initialize only after session_start: the extension still has no DB handle
    // when the first active transition starts its heartbeat.
    const otherProcessDb = openStateDb(root);
    t.after(() => otherProcessDb.close());
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    function publish(id: string) {
      const snapshot = selectConsolidation(otherProcessDb, { memoryVersion: "v1", now });
      const lease = claimConsolidation(otherProcessDb, { memoryVersion: "v1", owner: id, promptHash: "writer", inputRevisionHash: id, now });
      assert.ok(lease);
      const directory = join(root, "versions", "v1", "generations", id);
      mkdirSync(directory, { recursive: true });
      const summary = `v1\n## User Profile\n${id}\n## User preferences\n## General Tips\n## What's in Memory\n`;
      const handbook = `Handbook for ${id}`;
      writeFileSync(join(directory, "memory_summary.md"), summary);
      writeFileSync(join(directory, "MEMORY.md"), handbook);
      const manifest = JSON.stringify({ memoryVersion: "v1", controlEpoch: snapshot.controlEpoch, sources: [],
        fileHashes: { "memory_summary.md": hash(summary), "MEMORY.md": hash(handbook) } });
      writeFileSync(join(directory, "manifest.json"), manifest);
      assert.ok(commitGeneration(otherProcessDb, { lease, snapshot, generation: { memoryVersion: "v1", generationId: id,
        directory, manifestHash: hash(manifest), inputHash: id }, now }));
      now++;
      return directory;
    }
    const pinnedDirectory = publish("pinned-first");
    await mock.fire("before_agent_start", {}, ctx);
    assert.match((await projectRequest(mock, ctx)).memory ?? "", /pinned-first/);
    assert.equal(intervals.size, 1, "heartbeat starts before lazy DB acquisition");
    const started = now;
    for (let n = 0; n < 4; n++) publish(`replacement-${n}`);
    while (now <= started + GENERATION_PIN_TTL_MS) {
      now += 30_000;
      for (const beat of intervals.values()) beat();
    }
    cleanupGenerations({ db: otherProcessDb, root, now });
    assert.equal(existsSync(pinnedDirectory), true, "other process cleanup preserves the refreshed pin after its original TTL");
    assert.ok(otherProcessDb.prepare("SELECT 1 FROM generation_pins WHERE generation_id = ? AND expires_at > ?")
      .get("pinned-first", now));
    await mock.fire("agent_settled", {}, ctx);
    assert.equal(intervals.size, 0, "settlement clears the heartbeat");
    assert.equal(otherProcessDb.prepare("SELECT count(*) AS n FROM generation_pins").get()?.n, 0);
    cleanupGenerations({ db: otherProcessDb, root, now });
    assert.equal(existsSync(pinnedDirectory), false, "settled run releases its cleanup protection");
    await mock.fire("before_agent_start", {}, ctx);
    assert.ok((await projectRequest(mock, ctx)).memory);
    assert.equal(intervals.size, 1);
    await mock.fire("session_shutdown", {}, ctx);
    assert.equal(intervals.size, 0, "shutdown clears the heartbeat");
    assert.equal(otherProcessDb.prepare("SELECT count(*) AS n FROM generation_pins").get()?.n, 0);
  });
}
