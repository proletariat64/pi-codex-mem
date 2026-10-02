import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.ts";
import { runDoctor, type DoctorInput } from "../src/doctor.ts";
import { RUN_CRITICAL_EVENTS } from "../src/pi/compat.ts";

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
    foreground: {
      status: "active", reason: "carrier_full", memoryVersion: "v1",
      generationId: "gen-1", representation: "full", pinAvailable: true,
    },
    observedEvents: [...RUN_CRITICAL_EVENTS],
  };
}

test("healthy input produces an ok report covering all sections", () => {
  const report = runDoctor(goodInput());
  assert.equal(report.ok, true);
  const ids = report.probes.map((p) => p.id);
  for (const id of ["host", "paths", "config", "store", "model:extract", "model:consolidate", "foreground"]) {
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

test("unobserved host events cannot pass doctor before the first prompt", () => {
  for (const observedEvents of [undefined, [], ["session_start"]]) {
    const report = runDoctor({ ...goodInput(), observedEvents });
    const probe = report.probes.find((p) => p.id === "host-events");
    assert.equal(report.ok, false);
    assert.equal(probe?.status, "fail");
    assert.match(probe?.detail ?? "", /unverified/);
    assert.match(probe?.detail ?? "", /first prompt/);
    assert.match(probe?.detail ?? "", /doctor again/);
    for (const event of RUN_CRITICAL_EVENTS) assert.ok(probe?.detail.includes(event));
    assert.doesNotMatch(report.format()[0]!, /no blocking problems/);
  }
});

test("partial host event dispatch fails while full observation passes", () => {
  for (const missingEvent of RUN_CRITICAL_EVENTS) {
    const report = runDoctor({
      ...goodInput(),
      observedEvents: RUN_CRITICAL_EVENTS.filter((event) => event !== missingEvent),
    });
    assert.equal(report.ok, false);
    const probe = report.probes.find((p) => p.id === "host-events");
    assert.equal(probe?.status, "fail");
    assert.ok(probe?.detail.includes(missingEvent));
  }
  const report = runDoctor(goodInput());
  assert.equal(report.ok, true);
  assert.equal(report.probes.find((p) => p.id === "host-events")?.status, "ok");
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

test("unobserved foreground warns without claiming active injection", () => {
  const input = goodInput();
  delete input.foreground;
  const report = runDoctor(input);
  const probe = report.probes.find((p) => p.id === "foreground");
  assert.equal(probe?.status, "warn");
  assert.match(probe?.detail ?? "", /not yet observed/);
  assert.equal(report.ok, true);
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

test("foreground active reports version, generation, and full/clipped/minimal representation", () => {
  for (const memoryVersion of ["v1", "v2"] as const) {
    for (const representation of ["full", "clipped", "minimal"] as const) {
      const input = goodInput();
      input.foreground = {
        status: "active", reason: `carrier_${representation}`, memoryVersion,
        generationId: "gen-current", representation,
        warningCounts: representation === "minimal" ? { budget_minimal: 1, summary_clipped: 2 } : {},
      };
      const report = runDoctor(input);
      const probe = report.probes.find((p) => p.id === "foreground");
      assert.equal(report.ok, true);
      assert.equal(probe?.status, "ok");
      assert.ok(probe?.detail.includes(`${memoryVersion}/gen-current`));
      assert.ok(probe?.detail.includes(`${representation} carrier projected`));
      if (representation === "minimal") assert.match(probe?.detail ?? "", /budget_minimal=1, summary_clipped=2/);
    }
  }
});

test("budget omission is disabled, not active or a revocation of the retrieval pin", () => {
  const input = goodInput();
  input.foreground = {
    status: "disabled", reason: "budget_omitted", pinAvailable: true,
    warningCounts: { budget_omitted: 2, summary_clipped: 0 },
  };
  const report = runDoctor(input);
  const probe = report.probes.find((p) => p.id === "foreground");
  assert.equal(report.ok, true);
  assert.equal(probe?.status, "warn");
  assert.match(probe?.detail ?? "", /^disabled: budget_omitted; no active carrier; retrieval pin available/);
  assert.match(probe?.detail ?? "", /budget_omitted=2/);
  assert.doesNotMatch(probe?.detail ?? "", /summary_clipped=0|revoked/);
});

test("intentional disabling and ordinary invalidation are warnings, not integrity errors", () => {
  for (const reason of ["read_disabled", "warming_up", "retention_expired", "control_epoch_changed"]) {
    const input = goodInput();
    input.foreground = { status: "disabled", reason, pinAvailable: false };
    const report = runDoctor(input);
    const probe = report.probes.find((p) => p.id === "foreground");
    assert.equal(report.ok, true);
    assert.equal(probe?.status, "warn");
    assert.ok(probe?.detail.includes(reason));
    assert.match(probe?.detail ?? "", /retrieval pin unavailable/);
  }
});

test("foreground preparation/integrity errors fail and preserve the reason code", () => {
  for (const reason of ["preparation_failed", "manifest_mismatch", "unsafe_legacy_residue"]) {
    const input = goodInput();
    input.foreground = { status: "error", reason, pinAvailable: false };
    const report = runDoctor(input);
    const probe = report.probes.find((p) => p.id === "foreground");
    assert.equal(report.ok, false);
    assert.equal(probe?.status, "fail");
    assert.match(probe?.detail ?? "", /^error:/);
    assert.ok(probe?.detail.includes(reason));
  }
});

test("normal full prompt overrides and legacy section observations never imply carrier conflict", () => {
  for (const promptSections of ["confirmed", "unobserved", "unavailable", "conflict"] as const) {
    const input = { ...goodInput(), promptSections };
    const report = runDoctor(input);
    assert.equal(report.ok, true);
    assert.equal(report.probes.find((p) => p.id === "foreground")?.status, "ok");
    assert.equal(report.probes.some((p) => p.id === "prompt-sections"), false);
    assert.doesNotMatch(report.format().join("\n"), /section_injection_conflict|full system prompt/);
  }
});

test("doctor does not mutate diagnostic counts or config", () => {
  const input = goodInput();
  input.foreground = Object.freeze({
    status: "disabled", reason: "budget_omitted",
    warningCounts: Object.freeze({ summary_clipped: 2, budget_omitted: 1 }),
  });
  const before = JSON.stringify(input);
  runDoctor(input).format();
  assert.equal(JSON.stringify(input), before);
});
