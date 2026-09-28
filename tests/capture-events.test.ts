import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import memoryExtension from "../src/extension.ts";
import { makeMockPi } from "./mock-pi.ts";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function listRawFiles(root: string): string[] {
  const raw = join(root, "raw");
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(raw);
  return out;
}

test("live capture: session_start + input + turn_end writes raw events with provenance", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-capture-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentDir = join(base, "agent");
  const cwd = join(base, "repo");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();

  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getBranch: () => null },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("input", { type: "input", text: `${cwd} has a bug in the parser`, source: "rpc" }, ctx);
  await mock.fire(
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "text", text: "fixed the parser" }] },
      toolResults: [],
    },
    ctx,
  );

  const memoryRoot = join(agentDir, "memory");
  const files = listRawFiles(memoryRoot);
  const mirrors = files.filter((f) => f.endsWith(".md"));
  const evidence = files.filter((f) => f.endsWith(".json"));
  assert.equal(mirrors.length, 2, "user + assistant mirrors");
  assert.equal(evidence.length, 2, "user + assistant evidence");
  assert.ok(mirrors.some((f) => f.endsWith("-turn-0-user.md")));
  assert.ok(mirrors.some((f) => f.endsWith("-turn-0-assistant.md")));
  const userEvidence = JSON.parse(
    readFileSync(evidence.find((f) => f.endsWith("-user.json"))!, "utf8"),
  );
  assert.equal(userEvidence.canaries.gitCommit, head);
  assert.ok(userEvidence.provenance.verifiedBy.includes("cwd-prefix"));
  assert.equal(userEvidence.provenance.extractionMethod, "canary-verified");
});

test("live capture disabled via config writes nothing", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-capture-off-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentDir = join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const memoryRoot = join(agentDir, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  // Valid §14 config with capture disabled
  const { defaultConfig } = await import("../src/config.ts");
  writeFileSync(
    join(memoryRoot, "config.json"),
    JSON.stringify({ ...defaultConfig("UTC"), enabled: false }),
  );

  const mock = makeMockPi();
  memoryExtension(mock.pi);
  const ctx = {
    cwd: base,
    hasUI: false,
    sessionManager: { getBranch: () => null },
    modelRegistry: { find: () => ({}), streamSimple: () => ({}) },
  };
  await mock.fire("session_start", { type: "session_start" }, ctx);
  await mock.fire("input", { type: "input", text: "hello", source: "rpc" }, ctx);
  await mock.fire(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, toolResults: [] },
    ctx,
  );
  assert.deepEqual(listRawFiles(memoryRoot), []);
});
