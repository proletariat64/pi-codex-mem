#!/usr/bin/env node
// Offline by default. --execute is the only path that loads credentials or calls a model.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as undici from "undici";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import memoryExtension from "../src/extension.ts";
import { defaultConfig } from "../src/config.ts";
import { normalizeModelUsage } from "../src/model-usage.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { withCodexExtractionFormat } from "../src/extraction/format.ts";
import { v2PromptHash } from "../src/extraction/v2.ts";
import { consolidationPromptHash } from "../src/pipeline/consolidate.ts";
import { acquireReadView } from "../src/read/view.ts";
import { renderMemorySection } from "../src/read/inject.ts";
import { openStateDb } from "../src/store/db.ts";
import { planHistoricalImport, enrollHistoricalImport } from "../src/historical-import.ts";
import { forgetEvidence } from "../src/control/forget.ts";
import { ExtractionScheduler } from "../src/extraction/scheduler.ts";
import { ConsolidationScheduler } from "../src/pipeline/scheduler.ts";
import { buildSessionJsonl, selectedLeafId } from "./session.mjs";
import { finishExtractions } from "./extraction-retry.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "..");
const modes = ["none", "curated", "v1", "v2"];
const replySystem = "Answer the user's question concisely and accurately. Do not invent prior decisions, missing approvals, or project context. Say when evidence is unavailable. For memory-enabled modes, you may use the registered pi_memory tools to inspect relevant details; cite what you found without fabricating sources.";

function options(argv) {
  const opts = { reps: 3, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute" || arg === "--resume") { opts[arg.slice(2)] = true; continue; }
    if (!["--out", "--reps", "--case", "--extract", "--consolidate", "--answer", "--approved-max-usd"].includes(arg) || !argv[i + 1])
      throw new Error(`Unknown/missing option: ${arg}`);
    opts[arg.slice(2)] = argv[++i];
  }
  opts.reps = Number(opts.reps);
  if (!Number.isSafeInteger(opts.reps) || opts.reps < 1 || opts.reps > 3) throw new Error("--reps must be an integer 1..3");
  if (opts.execute) {
    for (const name of ["out", "extract", "consolidate", "answer", "approved-max-usd"])
      if (!opts[name]) throw new Error(`--execute requires --${name}`);
    const out = resolve(opts.out);
    if (out === projectRoot || out.startsWith(projectRoot + sep)) throw new Error("--out must be outside the repository");
    const max = Number(opts["approved-max-usd"]);
    if (!(max > 0 && Number.isFinite(max))) throw new Error("--approved-max-usd must be positive");
  }
  return opts;
}

function ref(raw) {
  const at = raw.indexOf("/");
  if (at < 1 || at === raw.length - 1) throw new Error(`Use provider/model-id, got: ${raw}`);
  return { provider: raw.slice(0, at), modelId: raw.slice(at + 1) };
}

function price(model, input, output) {
  // Catalog unit prices are USD / 1M tokens; cache-write is charged at the higher input tier.
  return (input * Math.max(model.cost.input, model.cost.cacheWrite ?? 0, model.cost.cacheRead ?? 0)
    + output * model.cost.output) / 1_000_000;
}

function chargeStore(db, runtime) {
  const rows = db.prepare("SELECT provider, model, actual_input, actual_output, reserved_input, reserved_output, call_count FROM budget_usage").all();
  let dollars = 0;
  for (const row of rows) {
    const model = runtime.getModel(row.provider, row.model);
    if (!model) throw new Error(`Usage for unknown model ${row.provider}/${row.model}`);
    // Open reservations are charged at their reserved worst case, not silently treated as zero.
    dollars += price(model, row.actual_input + row.reserved_input, row.actual_output + row.reserved_output);
  }
  return { dollars, rows };
}

function semanticGenerationFailure(agentDir, message) {
  const file = join(agentDir, "memory", "state.sqlite");
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const job = db.prepare("SELECT error_code FROM jobs WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 1").get();
      if (job?.error_code === "invalid_schema" && message.includes("Extraction did not complete")) return "extraction_invalid_schema";
      if (["validation_failed", "output_budget", "model_call_budget"].includes(job?.error_code) &&
          message.includes("Generation not published")) return `consolidation_${job.error_code}`;
    } finally { db.close(); }
  } catch { /* No state DB means an infrastructure failure, never a semantic miss. */ }
  return null;
}

function sourceFiles(item, cwd, dir, now) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const [index, source] of item.sourceSessions.entries()) {
    const path = join(dir, `${source.id}.jsonl`);
    if (!existsSync(path)) writeFileSync(path, buildSessionJsonl(item.id, source, cwd, now, index), { mode: 0o600 });
    paths.push([path, source]);
  }
  return paths;
}

async function generateMemory({ item, version, agentDir, root, paths, runtime, extract, consolidate, approval }) {
  const config = defaultConfig("UTC");
  config.version = version;
  config.models = { extract, consolidate };
  config.schedule.maxExtractionsPerPass = Math.max(2, item.sourceSessions.length);
  config.schedule.extractionConcurrency = 1; // avoid memory pressure on the host
  // Evaluate semantic quality rather than hitting the default daily quota mid-writer.
  // The separate USD approval guard still applies to every provider call.
  config.limits.dailyInputTokens = 4_000_000;
  config.limits.dailyOutputTokens = 200_000;
  config.limits.dailyRequests = 100;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const db = openStateDb(root);
  let charged = false;
  const results = { import: [], extraction: [], consolidation: [], forgotten: [],
    extractionUsage: null, consolidationUsage: null, usage: null };
  const port = {
    resolve: ({ provider, modelId }) => {
      const model = runtime.getModel(provider, modelId);
      return model && { provider, modelId, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    },
    async request(modelRef, context, opts) {
      const model = runtime.getModel(modelRef.provider, modelRef.modelId);
      if (!model) throw new Error("extraction model unavailable");
      if (approval.spent + chargeStore(db, runtime).dollars + price(model, Buffer.byteLength(JSON.stringify(context)), opts.maxTokens ?? model.maxTokens) > approval.max)
        throw new Error("spend_cap_exceeded_before_extraction");
      const { version, ...requestOptions } = opts;
      const response = await runtime.completeSimple(model, context, { ...requestOptions, transport: "sse", maxRetries: 0,
        ...(model.provider === "openai-codex"
          ? { onPayload: payload => withCodexExtractionFormat(payload, version) } : {}) });
      const text = response.content.filter(part => part.type === "text").map(part => part.text).join("");
      const trace = { stopReason: response.stopReason, text: text.slice(0, 8_192), errorMessage: response.errorMessage,
        inputTokens: normalizeModelUsage(response.usage)?.input ?? 0, outputTokens: response.usage?.output ?? 0 };
      writeFileSync(join(root, "extraction-trace.jsonl"), `${JSON.stringify(trace)}\n`, { flag: "a", mode: 0o600 });
      return { stopReason: response.stopReason === "pending" ? "error" : response.stopReason,
        text, errorMessage: response.errorMessage, usage: normalizeModelUsage(response.usage) };
    },
  };
  const writer = {
    resolve: ({ provider, modelId }) => runtime.getModel(provider, modelId),
    stream: (model, context, opts) => {
      if (approval.spent + chargeStore(db, runtime).dollars + price(model, Buffer.byteLength(JSON.stringify(context)), opts?.maxTokens ?? model.maxTokens) > approval.max)
        throw new Error("spend_cap_exceeded_before_writer_call");
      const stream = runtime.streamSimple(model, context, { ...opts, transport: "sse", maxRetries: 0 });
      const diagnostic = context.messages.findLast(message => message.role === "user" &&
        typeof message.content === "string" && message.content.includes("Host validation diagnostic"))?.content;
      void stream.result().then(message => {
        const trace = { stopReason: message.stopReason, errorMessage: message.errorMessage, model: model.id,
          repairDiagnostic: typeof diagnostic === "string" ? diagnostic.slice(0, 1_024) : undefined,
          tools: message.content.filter(part => part.type === "toolCall").map(part => part.name),
          stagedSummaryWrites: message.content.filter(part => part.type === "toolCall" && part.name === "workspace_write" &&
            part.arguments?.path === "memory_summary.md").map(part => JSON.stringify(part.arguments).slice(0, 5_000)),
          text: message.content.filter(part => part.type === "text").map(part => part.text).join("").slice(0, 600),
          inputTokens: message.usage.input + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0),
          outputTokens: message.usage.output };
        writeFileSync(join(root, "writer-trace.jsonl"), `${JSON.stringify(trace)}\n`, { flag: "a", mode: 0o600 });
      }).catch(() => { /* diagnostics must never change writer behavior */ });
      return stream;
    },
  };
  try {
    for (const [path, source] of paths) {
      const plan = planHistoricalImport(path, { leaf: selectedLeafId(source) });
      if (plan.unsupported.length || plan.deferred.length || plan.ambiguous.length || plan.candidates.length !== 1)
        throw new Error(`Source import plan failed: ${JSON.stringify(plan)}`);
      const result = enrollHistoricalImport(plan, { root, agentDir, db,
        limits: { itemBytes: 65_536, toolResultBytes: config.limits.toolResultBytes, totalBytes: config.limits.inputBytes } });
      if (result.imported !== 1) throw new Error(`Source import failed: ${JSON.stringify(result)}`);
      results.import.push(source.id);
    }
    const shared = { db, root, config: () => config, now: Date.now, isForegroundIdle: () => true,
      onError: error => { throw error; } };
    const extractor = new ExtractionScheduler({ ...shared, modelPort: () => port });
    try {
      results.extraction = await finishExtractions({ extractor, db, expected: item.sourceSessions.length });
    } finally { await extractor.stop(); }
    results.extractionUsage = chargeStore(db, runtime);
    const consolidator = new ConsolidationScheduler({ ...shared, modelPort: () => writer });
    try {
      results.consolidation = await consolidator.runPass();
    } finally { await consolidator.stop(); }
    if (!results.consolidation.some(value => value.status === "published"))
      throw new Error(`Generation not published: ${JSON.stringify(results.consolidation)}`);
    // A deletion after publication must revoke the prior generation before the new answering session.
    for (const id of item.forgetBeforeAnswer ?? []) {
      const file = paths.find(([, source]) => source.id === id)?.[0];
      const session = db.prepare("SELECT session_key FROM sessions WHERE path = ?").get(file);
      if (!session?.session_key) throw new Error(`Forgotten source session ${id} was not imported`);
      const forgotten = forgetEvidence({ root, db, kind: "session", id: session.session_key });
      if (!forgotten.forgotten || forgotten.cleanupPending) throw new Error(`Forget did not complete for ${id}`);
      results.forgotten.push(id);
    }
    results.usage = chargeStore(db, runtime);
    results.consolidationUsage = { dollars: Math.max(0, results.usage.dollars - results.extractionUsage.dollars) };
    approval.spent += results.usage.dollars;
    charged = true;
    // A read-only answer must not trigger an unrelated scheduled generation call.
    config.generate = false;
    writeFileSync(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    return results;
  } finally {
    if (!charged) {
      try { approval.spent += chargeStore(db, runtime).dollars; }
      catch { approval.unknownSpend = true; }
    }
    db.close();
  }
}

async function answer({ item, mode, cwd, agentDir, runtime, model, approval }) {
  let section = "";
  if (mode === "v1" || mode === "v2") {
    const db = new DatabaseSync(join(agentDir, "memory", "state.sqlite"), { readOnly: true });
    try {
      const view = acquireReadView({ db, root: join(agentDir, "memory"), memoryVersion: mode,
        extractionPromptHash: mode === "v1" ? v1PromptHash() : v2PromptHash() });
      if (item.forgetBeforeAnswer?.length) {
        if (view) throw new Error(`Forgotten source is still readable in ${mode} for ${item.id}`);
      } else {
        if (!view) throw new Error(`No readable ${mode} generation for ${item.id}`);
        section = renderMemorySection(view, cwd);
      }
    } finally { db.close(); }
  }
  let observedSection = "";
  const observeInjection = pi => pi.on("before_agent_start", event => {
    observedSection = event.systemPromptOptions?.sections?.pi_memory ?? "";
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true, noSkills: true,
    noPromptTemplates: true,
    extensionFactories: mode === "v1" || mode === "v2" ? [memoryExtension, observeInjection] : [],
    systemPromptOverride: () => replySystem,
    appendSystemPromptOverride: () => mode === "curated" ? [`Prior-session curated summary:\n${item.curatedSummary}`] : [],
  });
  await loader.reload();
  // Conservative per-request reservation: Pi can make several turns to read memory tools.
  // Refuse when remaining approval cannot cover an entire bounded answer session.
  const answerReserve = price(model, model.contextWindow * 4, model.maxTokens * 4);
  if (approval.spent + answerReserve > approval.max) throw new Error("spend_cap_exceeded_before_answer");
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false }, cacheWarming: "off", transport: "sse" }),
    noTools: mode === "v1" || mode === "v2" ? "builtin" : "all",
    excludeTools: ["pi_memory_note"], thinkingLevel: "off" });
  let input = 0; let output = 0; let cost = 0; let charged = false;
  try {
    if (extensionsResult.errors?.length) throw new Error(`Memory extension failed to load: ${JSON.stringify(extensionsResult.errors)}`);
    // SDK callers must bind extensions explicitly; otherwise session_start never runs.
    if (mode === "v1" || mode === "v2") await session.bindExtensions({ mode: "print" });
    const toolNames = session.getActiveToolNames();
    if (["v1", "v2"].includes(mode) &&
        (!toolNames.includes("pi_memory_read") || toolNames.some(name => !["pi_memory_search", "pi_memory_list", "pi_memory_read"].includes(name))))
      throw new Error(`Unexpected generated-mode tools: ${toolNames.join(", ")}`);
    if (["none", "curated"].includes(mode) && toolNames.some(name => name.startsWith("pi_memory_")))
      throw new Error("Baseline contaminated with memory tools");
    let turns = 0; let exceededTurns = false;
    const reads = [];
    session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        turns++;
        if (turns >= 4 && event.message.stopReason === "toolUse") {
          exceededTurns = true;
          void session.abort();
        }
        input += event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
        output += event.message.usage.output;
        cost += price(model, event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite,
          event.message.usage.output);
      }
      if (event.type === "tool_execution_end" && event.toolName.startsWith("pi_memory_")) reads.push(event.toolName);
    });
    const started = performance.now();
    await session.prompt(item.query);
    const elapsedMs = Math.round(performance.now() - started);
    if (section !== observedSection)
      throw new Error(`Published ${mode} section was not injected for ${item.id}`);
    const final = session.messages.findLast(message => message.role === "assistant");
    if (exceededTurns) throw new Error("Answer exceeded four model turns");
    if (!final || final.stopReason === "error" || final.stopReason === "aborted")
      throw new Error(`Answer failed: ${final?.errorMessage ?? "no assistant reply"}`);
    approval.spent += cost;
    charged = true;
    if (approval.spent > approval.max) throw new Error("spend_cap_exceeded_after_answer");
    let injectedBytes = 0;
    if (section) injectedBytes = Buffer.byteLength(section, "utf8");
    else if (mode === "curated") injectedBytes = Buffer.byteLength(`Prior-session curated summary:\n${item.curatedSummary}`, "utf8");
    return { text: final.content.filter(part => part.type === "text").map(part => part.text).join(""),
      inputTokens: input, outputTokens: output, estimatedUSD: cost, latencyMs: elapsedMs, memoryTools: reads,
      injectedBytes };
  } finally {
    if (!charged) approval.spent += cost;
    session.dispose();
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  // Never start credentials, even for a selected single-case run, until the full dataset passes preflight.
  execFileSync(process.execPath, [join(here, "validate.mjs")], { stdio: "inherit" });
  let cases;
  try { cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")); }
  catch (error) { throw new Error(`Cannot load evaluation cases: ${error}`, { cause: error }); }
  const selected = opts.case ? cases.filter(item => item.id === opts.case) : cases;
  if (!selected.length) throw new Error(`Unknown case ${opts.case}`);
  const total = selected.length * modes.length * opts.reps;
  console.log(`Plan: ${selected.length}/30 cases × ${modes.length} modes × ${opts.reps} reps = ${total} answers; ${cases.length - selected.length} cases excluded`);
  if (!opts.execute) { console.log("Offline preflight only; zero model requests."); return; }
  const extract = ref(opts.extract); const consolidate = ref(opts.consolidate); const answerRef = ref(opts.answer);
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const authDir = getAgentDir();
  // Pi CLI installs an Undici dispatcher before connecting. Bare SDK Node fetch can
  // ECONNRESET on authenticated Codex POSTs through the same local HTTP proxy.
  const proxy = SettingsManager.create(projectRoot, authDir, { projectTrusted: false }).getGlobalSettings().httpProxy;
  if (proxy) {
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
  }
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true }));
  undici.install();
  const runtime = await ModelRuntime.create({ authPath: join(authDir, "auth.json"), modelsPath: join(authDir, "models.json") });
  const resolvedAnswerModel = runtime.getModel(answerRef.provider, answerRef.modelId);
  if (!resolvedAnswerModel || !runtime.getModel(extract.provider, extract.modelId) || !runtime.getModel(consolidate.provider, consolidate.modelId))
    throw new Error("One or more models are missing from the authenticated Pi catalog");
  // Keep the four-mode answering budget independent of the selected model's enormous default context/output caps.
  const model = { ...resolvedAnswerModel, contextWindow: Math.min(resolvedAnswerModel.contextWindow, 32_768),
    maxTokens: Math.min(resolvedAnswerModel.maxTokens, 2_048) };
  const out = resolve(opts.out);
  if (opts.resume) {
    if (!existsSync(join(out, "plan.json"))) throw new Error("Cannot resume without an existing plan");
  } else mkdirSync(out, { recursive: false, mode: 0o700 });
  const now = Date.now();
  const approval = { max: Number(opts["approved-max-usd"]), spent: 0 };
  const promptHashes = { answer: createHash("sha256").update(replySystem).digest("hex") };
  for (const version of ["v1", "v2"]) {
    const config = defaultConfig("UTC");
    config.version = version;
    config.models = { extract, consolidate };
    promptHashes[version] = { extraction: version === "v1" ? v1PromptHash() : v2PromptHash(),
      consolidation: consolidationPromptHash(config, version) };
  }
  const plan = { selected: selected.map(item => item.id), modes, reps: opts.reps,
    models: { extract, consolidate, answer: answerRef }, transport: "sse",
    generationDailyLimits: { inputTokens: 4_000_000, outputTokens: 200_000, requests: 100 },
    answerLimits: { contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, maxTurns: 4 }, approvedMaxUSD: approval.max, promptHashes };
  let completed = new Set();
  if (opts.resume) {
    let prior;
    try { prior = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")); }
    catch (error) { throw new Error(`Resume plan unreadable: ${error}`, { cause: error }); }
    const { timestamp: _timestamp, ...priorPlan } = prior;
    if (JSON.stringify(priorPlan) !== JSON.stringify(plan)) throw new Error("Resume plan differs from original");
    const readLines = name => {
      try {
        return existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8")
          .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      } catch (error) { throw new Error(`Resume record ${name} unreadable: ${error}`, { cause: error }); }
    };
    const results = readLines("results.jsonl");
    const failures = readLines("failures.jsonl");
    const keys = selected.flatMap(item => Array.from({ length: opts.reps }, (_, i) => modes.map(mode =>
      `${item.id}/${mode}/${i + 1}`)).flat());
    if (results.some((row, i) => `${row.caseId}/${row.mode}/${row.rep}` !== keys[i]))
      throw new Error("Resume results are not a complete ordered prefix");
    completed = new Set(keys.slice(0, results.length));
    const last = [...results, ...failures].sort((a, b) => a.cumulativeEstimatedUSD - b.cumulativeEstimatedUSD).at(-1);
    approval.spent = last?.cumulativeEstimatedUSD ?? 0;
    if (failures.some(row => row.unknownSpend) || !Number.isFinite(approval.spent) || approval.spent > approval.max)
      throw new Error("Cannot resume with unknown or over-limit spend");
    const pendingFailure = failures.filter(row => !completed.has(`${row.caseId}/${row.mode}/${row.rep}`));
    if (pendingFailure.length > 1 || pendingFailure.some(row => `${row.caseId}/${row.mode}/${row.rep}` !== keys[results.length]))
      throw new Error("Cannot resume ambiguous failed slots");
    if (pendingFailure.length) {
      const row = pendingFailure[0];
      const store = join(out, "stores", row.caseId, String(row.rep), row.mode);
      const archive = join(out, "failed-attempts", `${row.caseId}-${row.rep}-${row.mode}`);
      if (!existsSync(store) || existsSync(archive)) throw new Error("Failed attempt archive is missing or already present");
      mkdirSync(join(out, "failed-attempts"), { recursive: true, mode: 0o700 });
      renameSync(store, archive);
    }
    console.log(`Resuming ${results.length}/${total} completed slots; accounted $${approval.spent.toFixed(4)}`);
  } else writeFileSync(join(out, "plan.json"), JSON.stringify({ ...plan,
    timestamp: new Date(now).toISOString() }, null, 2), { mode: 0o600 });
  try {
    for (const item of selected) {
      const cwd = join(out, "workspaces", item.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const paths = sourceFiles(item, cwd, join(out, "sources", item.id), now);
      for (let rep = 1; rep <= opts.reps; rep++) for (const mode of modes) {
        if (completed.has(`${item.id}/${mode}/${rep}`)) continue;
        const agentDir = join(out, "stores", item.id, String(rep), mode);
        const spentBefore = approval.spent;
        const attemptStarted = performance.now();
        try {
          mkdirSync(agentDir, { recursive: true, mode: 0o700 });
          process.env.PI_CODING_AGENT_DIR = agentDir;
          const generationStarted = performance.now();
          const generation = mode === "v1" || mode === "v2"
            ? await generateMemory({ item, version: mode, agentDir, root: join(agentDir, "memory"), paths,
              runtime, extract, consolidate, approval }) : null;
          const generationMs = generation ? Math.round(performance.now() - generationStarted) : 0;
          const reply = await answer({ item, mode, cwd, agentDir, runtime, model, approval });
          const result = { caseId: item.id, category: item.category, mode, rep, generation,
            ...reply, generationMs, totalLatencyMs: reply.latencyMs + generationMs,
            cumulativeEstimatedUSD: approval.spent };
          writeFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`, { flag: "a", mode: 0o600 });
          console.log(`${item.id} ${mode} rep=${rep} ${reply.latencyMs}ms $${approval.spent.toFixed(4)} / $${approval.max}`);
        } catch (error) {
          try {
            const failure = { caseId: item.id, mode, rep, error: String(error),
              cumulativeEstimatedUSD: approval.spent, unknownSpend: approval.unknownSpend === true };
            writeFileSync(join(out, "failures.jsonl"), `${JSON.stringify(failure)}\n`, { flag: "a", mode: 0o600 });
          } catch { console.error(`Could not write failure record for ${item.id}/${mode}/${rep}`); }
          const kind = semanticGenerationFailure(agentDir, String(error));
          if (!kind) throw error;
          const missed = { caseId: item.id, category: item.category, mode, rep,
            failed: true, failureKind: kind, text: "", inputTokens: 0, outputTokens: 0, latencyMs: 0,
            totalLatencyMs: Math.round(performance.now() - attemptStarted), memoryTools: [], injectedBytes: 0, estimatedUSD: 0,
            generationFailureUSD: approval.spent - spentBefore, cumulativeEstimatedUSD: approval.spent };
          writeFileSync(join(out, "results.jsonl"), `${JSON.stringify(missed)}\n`, { flag: "a", mode: 0o600 });
          console.error(`${item.id} ${mode} rep=${rep} semantic failure: ${kind} ($${approval.spent.toFixed(4)} / $${approval.max})`);
        }
      }
    }
  } finally {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
