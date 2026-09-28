import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.ts";
import { runDoctor, type DoctorInput } from "../src/doctor.ts";

function goodInput(): DoctorInput {
  return {
    compat: { supported: true, problems: [] },
    config: { status: "ok", config: defaultConfig("UTC"), path: "/mem/config.json" },
    paths: {
      memoryRoot: "/mem",
      rootExists: true,
      rootWritable: true,
      rootIsCodex: false,
    },
    store: { state: "absent" },
    models: {
      extract: { status: "configured", ref: { provider: "deepseek", modelId: "deepseek-chat" }, resolved: true },
      consolidate: { status: "configured", ref: { provider: "deepseek", modelId: "deepseek-chat" }, resolved: true },
    },
    promptSections: "confirmed",
  };
}

test("healthy input produces an ok report covering all sections", () => {
  const report = runDoctor(goodInput());
  assert.equal(report.ok, true);
  const ids = report.probes.map((p) => p.id);
  for (const id of ["host", "paths", "config", "store", "model:extract", "model:consolidate", "prompt-sections"]) {
    assert.ok(ids.includes(id), `missing probe ${id}`);
  }
  assert.ok(report.probes.every((p) => p.status !== "fail"));
});

test("unsupported host fails the report and names the compat problems", () => {
  const input = goodInput();
  input.compat = { supported: false, problems: ['host does not support the "agent_settled" event'] };
  const report = runDoctor(input);
  assert.equal(report.ok, false);
  const host = report.probes.find((p) => p.id === "host");
  assert.equal(host?.status, "fail");
  assert.ok(host?.detail?.includes("agent_settled"));
});

test("invalid config fails the report; file is reported as preserved", () => {
  const input = goodInput();
  input.config = { status: "invalid", problems: ["limits.summaryBytes must be ..."], path: "/mem/config.json" };
  const report = runDoctor(input);
  assert.equal(report.ok, false);
  const cfg = report.probes.find((p) => p.id === "config");
  assert.equal(cfg?.status, "fail");
  assert.match(cfg?.detail ?? "", /preserved|disabled/i);
});

test("absent store is a warning, not a failure", () => {
  const report = runDoctor(goodInput());
  const store = report.probes.find((p) => p.id === "store");
  assert.equal(store?.status, "warn");
  assert.equal(report.ok, true);
});

test("a legacy unversioned layout is a failure with legacy_layout_detected", () => {
  const input = goodInput();
  input.store = { state: "legacy_layout" };
  const report = runDoctor(input);
  const store = report.probes.find((p) => p.id === "store");
  assert.equal(store?.status, "fail");
  assert.match(store?.detail ?? "", /legacy_layout_detected/);
  assert.equal(report.ok, false);
});

test("memory root inside Codex/Claude-mem locations is rejected", () => {
  const input = goodInput();
  input.paths = { ...input.paths, rootIsCodex: true };
  const report = runDoctor(input);
  const paths = report.probes.find((p) => p.id === "paths");
  assert.equal(paths?.status, "fail");
  assert.equal(report.ok, false);
});

test("unconfigured models are a warning (defaults resolve on first use)", () => {
  const input = goodInput();
  input.models = { extract: { status: "unset" }, consolidate: { status: "unset" } };
  const report = runDoctor(input);
  assert.equal(report.ok, true);
  assert.equal(report.probes.find((p) => p.id === "model:extract")?.status, "warn");
});

test("a formatted report renders one line per probe", () => {
  const report = runDoctor(goodInput());
  const lines = report.format();
  assert.equal(lines.length, report.probes.length + 1); // header + probes
  assert.match(lines[0]!, /pi-memory doctor/);
});

test("a configured model that does not resolve in the registry fails", () => {
  const input = goodInput();
  input.models = {
    extract: { status: "configured", ref: { provider: "gone", modelId: "nope" }, resolved: false },
    consolidate: { status: "unset" },
  };
  const report = runDoctor(input);
  assert.equal(report.probes.find((p) => p.id === "model:extract")?.status, "fail");
  assert.equal(report.ok, false);
});

test("unobserved prompt sections warn; unavailable fails", () => {
  const input = goodInput();
  input.promptSections = "unobserved";
  assert.equal(runDoctor(input).probes.find((p) => p.id === "prompt-sections")?.status, "warn");
  input.promptSections = "unavailable";
  assert.equal(runDoctor(input).probes.find((p) => p.id === "prompt-sections")?.status, "fail");
});

test("legacy lock and corrupt control store are reported as failures", () => {
  const input = goodInput();
  input.config = { status: "missing", path: "/mem/config.json", reason: "legacy control lock; stop old processes" };
  input.store = { state: "unavailable" };
  const report = runDoctor(input);
  assert.equal(report.ok, false);
  assert.match(report.probes.find((p) => p.id === "config")?.detail ?? "", /legacy control lock/);
  assert.equal(report.probes.find((p) => p.id === "config")?.status, "fail");
  assert.equal(report.probes.find((p) => p.id === "store")?.status, "fail");
});

test("missing config warns instead of failing or creating", () => {
  const input = goodInput();
  input.config = { status: "missing", path: "/mem/config.json" };
  const report = runDoctor(input);
  assert.equal(report.probes.find((p) => p.id === "config")?.status, "warn");
  assert.equal(report.ok, true);
});
