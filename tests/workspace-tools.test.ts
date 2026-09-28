import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools } from "../src/pipeline/workspace-tools.ts";

test("writer tools restrict writes and deletion while reading Unicode evidence in bounded pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-tools-"));
  try {
    mkdirSync(join(dir, "rollout_summaries"));
    writeFileSync(join(dir, "rollout_summaries", "source.md"), "用户选择 TypeScript\n第二行\n第三行\n");
    const tools = createWorkspaceTools(dir);
    assert.deepEqual(tools.map((tool) => tool.name), ["workspace_list", "workspace_read", "workspace_search", "workspace_write", "workspace_delete"]);
    const call = async (name: string, args: unknown) => tools.find((tool) => tool.name === name)!.execute("call", args as never);
    const search = await call("workspace_search", { query: "用户" });
    assert.match(JSON.stringify(search), /用户选择 TypeScript/);
    const page = await call("workspace_read", { path: "rollout_summaries/source.md", startLine: 2, maxLines: 1 });
    assert.match(JSON.stringify(page), /第二行/);
    assert.doesNotMatch(JSON.stringify(page), /第三行/);
    for (const path of ["../escape.md", "/tmp/escape.md", "C:\\escape.md", "rollout_summaries/source.md", "notes/n.md", "skills/run/script.sh"]) {
      await assert.rejects(call("workspace_write", { path, content: "blocked" }));
    }
    await call("workspace_write", { path: "MEMORY.md", content: "handbook" });
    assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), "handbook");
    await assert.rejects(call("workspace_delete", { path: "MEMORY.md" }));
    await call("workspace_write", { path: "skills/safe/SKILL.md", content: "prose" });
    await call("workspace_delete", { path: "skills/safe/SKILL.md" });
    symlinkSync(join(dir, "rollout_summaries"), join(dir, "skills", "linked"));
    await assert.rejects(call("workspace_write", { path: "skills/linked/SKILL.md", content: "blocked" }));
    symlinkSync("/etc/passwd", join(dir, "linked.md"));
    await assert.rejects(call("workspace_read", { path: "linked.md" }));
    await assert.rejects(call("workspace_list", {}));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace pages enforce response byte caps and retain Unicode across paginated reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-pages-"));
  try {
    writeFileSync(join(dir, "evidence.md"), Array.from({ length: 40 }, (_, index) => `用户选择 TypeScript ${index}`).join("\n"));
    const tools = createWorkspaceTools(dir, { responseBytes: 512 });
    const read = tools.find((tool) => tool.name === "workspace_read")!;
    const page = await read.execute("read", { path: "evidence.md", maxLines: 40 });
    assert.ok(Buffer.byteLength(page.content[0]!.type === "text" ? page.content[0]!.text : "") <= 512);
    assert.equal(page.details.truncated, true);
    const next = await read.execute("read", { path: "evidence.md", startLine: Number(page.details.cursor) + 1, maxLines: 40 });
    assert.ok(next.details.items[0].line > page.details.items[0].line);
    assert.match(JSON.stringify(next), /用户选择/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
