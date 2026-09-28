import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContextEditEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { applyContextEdits } from "../src/snapshot.ts";

function msg(id: string, role: "user" | "assistant", text: string): SessionMessageEntry {
  const message =
    role === "user"
      ? { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
          api: "openai-completions",
          provider: "openai",
          model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: 0,
        };
  return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}

function edit(id: string, targetId: string, replacement: { content: unknown } | null): ContextEditEntry {
  return {
    type: "context_edit",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    targetId,
    replacement: replacement as ContextEditEntry["replacement"],
  };
}

// Spec §7.1: latest branch-local context_edit applies; null excludes the target.

test("null replacement excludes the target from new evidence (T10)", () => {
  const entries: SessionEntry[] = [msg("m1", "user", "my password is hunter2"), edit("e1", "m1", null)];
  const out = applyContextEdits(entries);
  assert.equal(out.filter((e) => e.type === "message").length, 0, "target removed");
  assert.equal(out.filter((e) => e.type === "context_edit").length, 0, "edit entries are consumed");
});

test("replacement keeps source ID and role but substitutes content (§7.1)", () => {
  const entries: SessionEntry[] = [
    msg("m1", "user", "secret text"),
    edit("e1", "m1", { content: [{ type: "text", text: "[redacted by user]" }] }),
  ];
  const out = applyContextEdits(entries);
  assert.equal(out.length, 1);
  const m = out[0] as SessionMessageEntry;
  assert.equal(m.id, "m1");
  assert.equal(m.message.role, "user");
  assert.deepEqual((m.message as { content: unknown }).content, [{ type: "text", text: "[redacted by user]" }]);
});

test("the LATEST edit per target wins (§7.1)", () => {
  const entries: SessionEntry[] = [
    msg("m1", "user", "original"),
    edit("e1", "m1", { content: [{ type: "text", text: "first edit" }] }),
    edit("e2", "m1", { content: [{ type: "text", text: "latest edit" }] }),
  ];
  const out = applyContextEdits(entries) as SessionMessageEntry[];
  assert.equal(out.length, 1);
  assert.deepEqual((out[0]!.message as { content: unknown }).content, [{ type: "text", text: "latest edit" }]);
});

test("untargeted entries pass through untouched", () => {
  const entries: SessionEntry[] = [msg("m1", "user", "keep me"), msg("m2", "assistant", "ok"), edit("e1", "mX", null)];
  const out = applyContextEdits(entries);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.id), ["m1", "m2"]);
});
