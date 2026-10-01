import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../src/extension.ts';
import { defaultConfig } from '../src/config.ts';
import { openStateDb } from '../src/store/db.ts';
import { claimConsolidation, commitGeneration, selectConsolidation } from '../src/store/consolidation.ts';
import { renderMemoryCarrier } from '../src/read/inject.ts';
import { requestCapacity } from '../src/read/projection.ts';

// Actual package runner, forced projection and converter; transcripts/compaction are synthetic.
const host = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url));
const { ExtensionRunner } = await import(join(host, 'dist/core/extensions/runner.js'));
const { createExtensionRuntime, loadExtensionFromFactory } = await import(join(host, 'dist/core/extensions/loader.js'));
const { createEventBus } = await import(join(host, 'dist/core/event-bus.js'));
const { AgentSession } = await import(join(host, 'dist/core/agent-session.js'));
const { convertToLlm } = await import(join(host, 'dist/core/messages.js'));
const hash = text => createHash('sha256').update(text).digest('hex');
const summary = `v1\n## User Profile\n${'Chinese discussion decisions matter. '.repeat(12)}\n\n## User preferences\nScoped only.\n## General Tips\nCheck current owning sources.\n## What's in Memory\n### Project\n#### 2026-09-30\n- TypeScript: rollout_summaries/source.md\n  - desc: Choice, rationale and conditions.\n`;
const head = { role: 'system', sections: { preamble: 'BASE', stable: 'original' }, content: '', timestamp: 0,
  toolsAdded: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }] };
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const call = id => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }], timestamp: 2 });
const result = id => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 });

for (const version of ['v1', 'v2']) for (const order of ['memory-first', 'override-first']) for (const forced of [false, true]) {
  test(`installed host native projection ${version}/${order}/override=${forced}`, async t => {
    const packageVersion = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version;
    assert.match(packageVersion, /^\d+\.\d+\.\d+/); // evidence, never a host allowlist
    const base = mkdtempSync(join(tmpdir(), 'pi-native-projection-')); const cwd = join(base, 'repo'); mkdirSync(cwd);
    const agentDir = join(base, 'agent'); const root = join(agentDir, 'memory'); mkdirSync(root, { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = { ...defaultConfig('UTC'), version, generate: false, captureModes: [] };
    writeFileSync(join(root, 'config.json'), JSON.stringify(config));
    const db = openStateDb(root);
    function publish(id) {
      const now = Date.now(); const snapshot = selectConsolidation(db, { memoryVersion: version, now });
      const lease = claimConsolidation(db, { memoryVersion: version, owner: 'host-test', promptHash: 'writer', inputRevisionHash: id, now });
      assert.ok(lease);
      const directory = join(root, 'versions', version, 'generations', id);
      const files = { 'memory_summary.md': summary, 'rollout_summaries/source.md': '中文选择与理由',
        ...(version === 'v1' ? { 'MEMORY.md': 'Scoped handbook' } : {}) };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), text);
      }
      const manifest = JSON.stringify({ memoryVersion: version, controlEpoch: snapshot.controlEpoch, sources: [],
        fileHashes: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, hash(text)])) });
      writeFileSync(join(directory, 'manifest.json'), manifest);
      assert.equal(commitGeneration(db, { lease, snapshot, generation: { memoryVersion: version, generationId: id,
        directory, manifestHash: hash(manifest), inputHash: id }, now }), true);
      return { memoryVersion: version, generationId: id, controlEpoch: snapshot.controlEpoch, manifestHash: hash(manifest),
        directory, summary, applicability: [], retentionDeadline: null };
    }
    const firstFormatting = publish('first');
    const runtime = createExtensionRuntime(); const bus = createEventBus(); const errors = []; let fold = false;
    const names = order === 'memory-first' ? ['memory', 'override'] : ['override', 'memory'];
    const extensions = await Promise.all(names.map(name => loadExtensionFromFactory(pi => {
      if (name === 'memory') extension(pi);
      else {
        if (forced) pi.on('before_agent_start', () => ({ systemPrompt: 'EXACT_FORCED_TEXT' }));
        pi.on('context', event => fold ? { messages: [...event.messages, { role: 'custom', customType: 'other',
          content: 'OTHER', display: false, timestamp: 0 }] } : undefined);
      }
    }, cwd, bus, runtime, `inline:${name}`)));
    const canonical = [head, user('first user')]; const branch = [];
    const sessionManager = { getHeader: () => ({ id: 'native-fixture' }), getSessionFile: () => join(base, 'session.jsonl'),
      getLeafId: () => null, getBranch: () => branch };
    const model = { provider: 'fake', api: 'openai-completions', id: 'model', contextWindow: 200_000, maxTokens: 1_000 };
    const registry = { find: () => model, streamSimple: () => { throw new Error('no model calls permitted'); } };
    let aborted = false; let options = {};
    const runner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, registry);
    runner.bindCore({ getThinkingLevel: () => 'off' }, { getModel: () => model, getScopedModels: () => [],
      isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
      abort: () => { aborted = true; }, hasPendingMessages: () => false, shutdown: () => {},
      getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => '', getSystemPromptOptions: () => options });
    runner.onError(error => errors.push(error));
    const session = { agent: { transformContext: messages => runner.emitContext(messages) }, _runSystemPromptOptions: options };
    AgentSession.prototype._installAgentForcedPromptProjection.call(session);
    t.after(async () => {
      try { await runner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { db.close(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(base, { recursive: true, force: true }); }
    });
    await runner.emit({ type: 'session_start', reason: 'new' });
    async function begin(text) {
      const prepared = await runner.emitBeforeAgentStart(text, undefined, { cwd, sections: {}, selectedTools: ['read'], skills: [] });
      options = prepared.systemPromptOptions; session._runSystemPromptOptions = options;
      assert.equal(options.sections.pi_memory, undefined);
      if (forced) assert.equal(options.forceSystemPrompt, 'EXACT_FORCED_TEXT');
      await runner.emit({ type: 'agent_start' });
    }
    async function diagnostic(expected) {
      const context = runner.createCommandContext(); const notifications = [];
      await runner.getCommand('memory').handler('doctor', { ...context, hasUI: true,
        ui: { ...context.ui, notify: text => notifications.push(text) } });
      assert.match(notifications.join('\n'), expected);
    }
    async function project(messages, expectedGeneration = 'first', carrierExpected = true) {
      const snapshot = structuredClone(messages); const projection = await session.agent.transformContext(messages);
      assert.deepEqual(messages, snapshot);
      const carriers = projection.filter(message => message.customType === 'pi_memory');
      assert.equal(carriers.length, carrierExpected ? 1 : 0);
      if (carrierExpected) {
        assert.equal(projection.findIndex(message => message.customType === 'pi_memory'), projection[0]?.role === 'system' ? 1 : 0);
        assert.match(carriers[0].content, new RegExp(`Generation ID: "${expectedGeneration}"`));
      }
      if (forced) assert.equal(projection[0].content, 'EXACT_FORCED_TEXT');
      for (let index = 0; index < projection.length; index++) if (projection[index].role === 'toolResult') {
        assert.equal(projection[index - 1].role, 'assistant');
      }
      const converted = convertToLlm(projection);
      assert.equal(converted.filter(message => message.role === 'user' && Array.isArray(message.content) &&
        message.content.some(part => part.text?.includes('Host-provided read guidance'))).length, carrierExpected ? 1 : 0);
      assert.equal(JSON.stringify(canonical).includes('Host-provided read guidance'), false);
      assert.equal(JSON.stringify(branch).includes('Host-provided read guidance'), false);
      return projection;
    }
    await begin('first user');
    const projected = await project(canonical);
    assert.deepEqual(projected[0].toolsAdded, head.toolsAdded);
    await diagnostic(/full carrier projected/);
    await project([...canonical, call('one'), result('one')]);
    await project([...canonical, call('one'), result('one'), call('two'), result('two')]);
    publish('second'); await project(canonical, 'first');
    await runner.emit({ type: 'session_before_compact', trigger: 'threshold' });
    await runner.emit({ type: 'session_compact', trigger: 'threshold' });
    await project([head, { role: 'compactionSummary', summary: 'SYNTHETIC compaction', timestamp: 0, tokensBefore: 10 }, user('continue')]);
    fold = true;
    const delta = { role: 'system', content: '', sections: { stable: 'changed' }, toolsRemoved: head.toolsAdded,
      toolsAdded: [{ name: 'bash', description: 'bash', parameters: { type: 'object', properties: {} } }], timestamp: 0 };
    const folded = await project([...canonical, delta, user('next')]);
    assert.equal(folded.filter(message => message.role === 'system').length, 1);
    assert.equal(folded.some(message => message.customType === 'other'), true);
    assert.deepEqual(folded[0].toolsAdded, delta.toolsAdded); fold = false;
    const nonCarrierReserve = model.contextWindow - model.maxTokens - requestCapacity(canonical, model.contextWindow, model.maxTokens);
    // Pure carrier rendering receives a formatting DTO, not a live pin.
    const minimum = renderMemoryCarrier({ ...firstFormatting, summary: 'v1\n' + 'x'.repeat(10_000) }, cwd, { capacity: 100_000 });
    model.contextWindow = model.maxTokens + nonCarrierReserve + minimum.units + 200;
    await project(canonical, 'first');
    await diagnostic(/clipped carrier projected/);
    model.contextWindow = model.maxTokens + nonCarrierReserve + minimum.units + 2;
    const minimal = await project(canonical, 'first');
    assert(!minimal.find(message => message.customType === 'pi_memory').content.includes('Chinese discussion decisions matter'));
    await diagnostic(/minimal carrier projected/);
    model.contextWindow = 1; await project(canonical, 'first', false);
    await diagnostic(/disabled: capacity_exhausted; no active carrier; counting=utf8_upper_estimate; retrieval pin available/);
    const list = runner.getToolDefinition('pi_memory_list');
    const available = await list.execute('list', {}, undefined, undefined, runner.createContext());
    assert.equal(available.details.error, undefined);
    model.contextWindow = 200_000;
    const oldOwned = { role: 'custom', customType: 'pi_memory', content: 'old owned', display: false, timestamp: 0 };
    await project([head, oldOwned, user('request')]);
    await runner.emit({ type: 'agent_settled' }); await begin('second user'); await project(canonical, 'second');
    db.exec("UPDATE store_state SET control_epoch = control_epoch + 1; UPDATE pipeline_state SET read_blocked = 1, block_reason = 'user_correction'");
    await project(canonical, 'second', false);
    await diagnostic(/disabled: control_epoch_changed; no active carrier; retrieval pin unavailable/);
    const denied = await list.execute('list', {}, undefined, undefined, runner.createContext());
    assert.equal(denied.details.error, 'memory_unavailable');
    publish('clean'); await project(canonical, 'clean', false); // no user/privacy mid-run recovery
    await runner.emit({ type: 'agent_settled' }); await begin('third user'); await project(canonical, 'clean');
    await runner.emit({ type: 'session_tree', newLeafId: 'other', oldLeafId: null }); await project(canonical, 'clean', false);
    assert.equal(aborted, false);
    await begin('dispatch race');
    const admitted = await project(canonical, 'clean');
    const carrierText = admitted.find(message => message.customType === 'pi_memory').content;
    const payload = { messages: [{ role: 'system', content: 'EXACT_OTHER_POLICY' },
      { role: 'user', content: [{ type: 'text', text: carrierText }] }, user('REAL_HUMAN')], tools: head.toolsAdded, max_tokens: 1000 };
    const payloadSnapshot = structuredClone(payload);
    db.exec('UPDATE store_state SET control_epoch = control_epoch + 1');
    const replacement = await runner.emitBeforeProviderRequest(payload);
    assert.deepEqual(payload, payloadSnapshot);
    assert.equal(JSON.stringify(replacement).includes('Host-provided read guidance'), false);
    assert.deepEqual(replacement.tools, payload.tools);
    assert.equal(replacement.messages[0].content, 'EXACT_OTHER_POLICY');
    assert.equal(JSON.stringify(replacement).includes('REAL_HUMAN'), true);
    assert.equal(aborted, false);
    publish('after-race'); await begin('opaque dispatch');
    const unsafe = await project(canonical, 'after-race');
    const unsafeText = unsafe.find(message => message.customType === 'pi_memory').content;
    db.exec('UPDATE store_state SET control_epoch = control_epoch + 1');
    await runner.emitBeforeProviderRequest({ opaque: unsafeText });
    assert.equal(aborted, true); // native binding exercised; transport enforcement is tested separately
    await diagnostic(/error: unsafe_provider_residue/);
    aborted = false; publish('codex'); model.api = 'openai-codex-responses';
    await begin('accepted transport race');
    const codexProjection = await project(canonical, 'codex');
    assert.equal((await list.execute('list', {}, undefined, undefined, runner.createContext())).details.error, undefined);
    const codexPayload = { input: [{ role: 'user', content: codexProjection.find(message => message.customType === 'pi_memory').content }, user('REAL_HUMAN')], tools: head.toolsAdded };
    db.exec('UPDATE store_state SET control_epoch = control_epoch + 1');
    assert.deepEqual(await runner.emitBeforeProviderRequest(codexPayload), { ...codexPayload, input: [user('REAL_HUMAN')] });
    assert.equal((await list.execute('list', {}, undefined, undefined, runner.createContext())).details.error, 'memory_unavailable');
    assert.equal(aborted, false); assert.deepEqual(errors, []);
  });
}
