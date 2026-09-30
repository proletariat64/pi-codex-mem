import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessStore, canReadMemory, canWriteNote, canCaptureTranscript,
  canGenerateMemory, canExtractMemory, canConsolidateMemory, canImportHistory, canCreateConfig,
  type ConfigFacts, type ExtractionFacts, type StoreAccessFacts,
} from "../src/runtime-policy.ts";

const config: NonNullable<ConfigFacts["config"]> = {
  enabled: true, read: true, generate: true, captureModes: ["tui"],
};
const facts: ExtractionFacts = { config, flag: undefined, workspaceExcluded: false, persistent: true, mode: "tui" };
const host: StoreAccessFacts = { supported: true, foreignRoot: false, legacyLocked: false };
const store = { available: true, reconciliationPending: false };

for (const [name, change] of [
  ["unsupported host", { supported: false }],
  ["foreign root", { foreignRoot: true }],
  ["legacy lock", { legacyLocked: true }],
] satisfies [string, Partial<StoreAccessFacts>][]) {
  test(`store access rejects ${name}`, () => {
    assert.equal(canAccessStore(host), true);
    assert.equal(canAccessStore({ ...host, ...change }), false);
  });
}

const operations: [string, (facts: ExtractionFacts) => boolean][] = [
  ["read", canReadMemory],
  ["notes", canWriteNote],
  ["capture", canCaptureTranscript],
  ["generation", canGenerateMemory],
  ["extraction", canExtractMemory],
  ["consolidation", input => canConsolidateMemory(input, store)],
];
for (const [name, allowed] of operations) {
  test(`${name} requires valid enabled config, workspace eligibility and a non-off flag`, () => {
    assert.equal(allowed(facts), true);
    for (const [failure, change] of [
      ["missing or invalid config", { config: null }],
      ["disabled config", { config: { ...config, enabled: false } }],
      ["excluded workspace", { workspaceExcluded: true }],
      ["off flag", { flag: "off" }],
    ] satisfies [string, Partial<ExtractionFacts>][]) {
      assert.equal(allowed({ ...facts, ...change }), false, failure);
    }
    assert.equal(allowed({ ...facts, flag: "read-write" }), true);
  });
}

test("read flag permits reads; configured read=false still forbids them", () => {
  assert.equal(canReadMemory({ ...facts, flag: "read" }), true);
  assert.equal(canReadMemory({ ...facts, config: { ...config, read: false } }), false);
  assert.equal(canReadMemory({ ...facts, flag: "read-write", config: { ...config, read: false } }), false);
});

for (const [name, allowed] of operations.filter(([name]) => name !== "read")) {
  test(`${name} rejects a read-only CLI flag but does not require config.read`, () => {
    assert.equal(allowed({ ...facts, flag: "read" }), false);
    assert.equal(allowed({ ...facts, config: { ...config, read: false } }), true);
  });
}

test("generate=false still allows reads, capture and explicit notes", () => {
  const paused = { ...facts, config: { ...config, generate: false } };
  assert.equal(canReadMemory(paused), true);
  assert.equal(canWriteNote(paused), true);
  assert.equal(canCaptureTranscript(paused), true);
  assert.equal(canGenerateMemory(paused), false);
  assert.equal(canExtractMemory(paused), false);
  assert.equal(canConsolidateMemory(paused, { ...store, reconciliationPending: true }), false);
});

test("ephemeral sessions may read or write notes but cannot generate", () => {
  const ephemeral = { ...facts, persistent: false };
  assert.equal(canReadMemory(ephemeral), true);
  assert.equal(canWriteNote(ephemeral), true);
  // Capture's session-file/header/leaf validation remains at the caller, not this runtime gate.
  assert.equal(canCaptureTranscript(ephemeral), true);
  assert.equal(canGenerateMemory(ephemeral), false);
  assert.equal(canExtractMemory(ephemeral), false);
  assert.equal(canConsolidateMemory(ephemeral, { ...store, reconciliationPending: true }), false);
});

test("capture and extraction require the current capture mode, unlike generation and notes", () => {
  for (const mode of ["rpc", "json", "print", "unknown"]) {
    const disabledMode = { ...facts, mode };
    assert.equal(canCaptureTranscript(disabledMode), false, mode);
    assert.equal(canExtractMemory(disabledMode), false, mode);
    assert.equal(canGenerateMemory(disabledMode), true, mode);
    assert.equal(canWriteNote(disabledMode), true, mode);
  }
  const rpc = { ...facts, mode: "rpc", config: { ...config, captureModes: ["rpc"] } } satisfies ExtractionFacts;
  assert.equal(canCaptureTranscript(rpc), true);
  assert.equal(canExtractMemory(rpc), true);
  assert.equal(canCaptureTranscript({ ...facts, config: { ...config, captureModes: [] } }), false);
});

test("RPC consolidation requires a store and pending note/revocation reconciliation", () => {
  const rpc = { ...facts, mode: "rpc" };
  assert.equal(canConsolidateMemory(rpc, store), false);
  assert.equal(canConsolidateMemory(rpc, { ...store, reconciliationPending: true }), true);
  assert.equal(canConsolidateMemory(facts, { ...store, available: false }), false);
  assert.equal(canConsolidateMemory(rpc, { available: false, reconciliationPending: true }), false);
});

test("generation predicates add no host/root condition; foreground run and model defaults use the store guard", () => {
  for (const rejectedHost of [
    { ...host, supported: false }, { ...host, foreignRoot: true }, { ...host, legacyLocked: true },
  ]) {
    assert.equal(canGenerateMemory(facts), true);
    assert.equal(canExtractMemory(facts), true);
    assert.equal(canAccessStore(rejectedHost) && canExtractMemory(facts), false);
  }
});

test("import has config/flag gates but no current-workspace, persistence, mode, read or generation gate", () => {
  const importFacts = { ...facts, persistent: false, mode: "rpc", workspaceExcluded: true,
    config: { ...config, read: false, generate: false, captureModes: [] } };
  assert.equal(canImportHistory(importFacts), true);
  for (const change of [
    { config: null }, { config: { ...config, enabled: false } }, { flag: "off" }, { flag: "read" },
  ] satisfies Partial<ExtractionFacts>[]) {
    assert.equal(canImportHistory({ ...importFacts, ...change }), false);
  }
});

test("management and branch/privacy reconciliation use only store safety, even with all ordinary gates disabled", () => {
  const disabled = { ...host, ...facts, config: null, flag: "off", workspaceExcluded: true, persistent: false, mode: "rpc" };
  assert.equal(canAccessStore(disabled), true);
  assert.equal(canAccessStore({ ...disabled, legacyLocked: true }), false);
});

test("startup config creation requires a supported persistent session and writable CLI mode only", () => {
  const startup = { ...host, ...facts, config: null, workspaceExcluded: true, mode: "rpc", legacyLocked: true };
  assert.equal(canCreateConfig(startup), true);
  assert.equal(canCreateConfig({ ...startup, flag: "read-write" }), true);
  for (const change of [
    { supported: false }, { persistent: false }, { flag: "off" }, { flag: "read" },
  ] satisfies Partial<typeof startup>[]) {
    assert.equal(canCreateConfig({ ...startup, ...change }), false);
  }
});
