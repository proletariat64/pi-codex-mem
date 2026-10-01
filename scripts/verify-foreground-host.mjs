// Read-only installed-host probe. All provider transports are intercepted; no credentials/network.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
async function main() {
const H = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent', import.meta.url));
const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(H + '/dist/index.js');
const { createExtensionRuntime, loadExtensionFromFactory } = await import(H + '/dist/core/extensions/loader.js');
const { createEventBus } = await import(H + '/dist/core/event-bus.js');
const cwd = mkdtempSync(join(tmpdir(), 'pi-native-fence-'));
function parseJson(text) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error('Invalid JSON in host probe', { cause }); }
}
const hostVersion = parseJson(readFileSync(H + '/package.json')).version;
assert.match(hostVersion, /^\d+\.\d+\.\d+/); // evidence, not a compatibility gate
let cachedAbortSafe = null;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let fetches = [], websocketOpens = 0, websocketFrames = [];
globalThis.fetch = async (url, options) => {
  const body = new Headers(options.headers).get('content-encoding') === 'zstd'
    ? zstdDecompressSync(options.body).toString('utf8') : options.body;
  fetches.push({ url: String(url), body: parseJson(body), aborted: options.signal?.aborted });
  return new Response(JSON.stringify({ error: { message: 'deterministic transport sentinel', type: 'invalid_request_error' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
};
globalThis.WebSocket = class extends EventTarget {
  readyState = 1;
  constructor() { super(); websocketOpens++; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  close() { this.readyState = 3; }
  send(data) {
    websocketFrames.push(parseJson(data));
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'response.completed', response: { id: 'r' + websocketFrames.length, status: 'completed', output: [],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } },
    }) })));
  }
};
const jwt = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url'), 'dummy'].join('.');
try {
  for (const api of ['openai-responses', 'openai-completions', 'openai-codex-responses']) {
    for (const transport of api === 'openai-codex-responses' ? ['sse', 'websocket', 'websocket-cached'] : ['sse']) {
      for (const action of transport === 'websocket-cached' ? ['abort-cached', 'abort-context-cached'] : ['pass', 'throw', 'replace', 'abort']) {
        fetches = []; websocketOpens = 0; websocketFrames = [];
        const runtime = await ModelRuntime.create({ modelsPath: null, authPath: cwd + '/nonexistent-auth.json', refreshOnCreate: false });
        runtime.registerProvider('host-evidence', {
          api, apiKey: api === 'openai-codex-responses' ? jwt : 'dummy-local', baseUrl: 'https://invalid.example/v1',
          models: [{ id: 'evidence-model', name: 'evidence-model', reasoning: false, input: ['text'], contextWindow: 32768,
            maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        });
        const model = runtime.getModel('host-evidence', 'evidence-model');
        assert(model);
        const extensionRuntime = createExtensionRuntime(), bus = createEventBus();
        const errors = [], events = [];
        let hookCalls = 0, immediatelyAborted = false;
        const extension = await loadExtensionFromFactory(pi => {
          pi.on('before_agent_start', () => ({ systemPrompt: 'EXACT_FORCED_TEXT' }));
          pi.on('context_with_system', (event, ctx) => {
            if (action === 'abort-context-cached' && hookCalls === 1) {
              ctx.abort(); immediatelyAborted = ctx.signal.aborted;
            }
            const messages = event.messages.slice();
            messages.splice(messages[0]?.role === 'system' ? 1 : 0, 0, {
              role: 'custom', customType: 'pi_memory_context', content: 'OWNED_CARRIER_SENTINEL_' + hookCalls, display: false, timestamp: 1,
            });
            return { messages };
          });
          pi.on('before_provider_request', (event, ctx) => {
            hookCalls++;
            assert(JSON.stringify(event.payload).includes('OWNED_CARRIER_SENTINEL'));
            if (action === 'throw') throw new Error('hook sentinel');
            if (action === 'abort' || (action === 'abort-cached' && hookCalls === 2)) {
              ctx.abort();
              immediatelyAborted = ctx.signal.aborted;
            }
            if (action === 'replace') {
              const key = api === 'openai-completions' ? 'messages' : 'input';
              const kept = event.payload[key].filter(item => !JSON.stringify(item).includes('OWNED_CARRIER_SENTINEL'));
              assert.equal(kept.length, event.payload[key].length - 1);
              return { ...event.payload, [key]: kept };
            }
          });
        }, cwd, bus, extensionRuntime, 'inline:host-evidence');
        const loader = {
          getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
          getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
          getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
          getSystemPrompt: () => 'BASE_PROMPT', getSystemPromptSource: () => undefined,
          getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
          extendResources: () => {}, reload: async () => {},
        };
        const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime, resourceLoader: loader,
          tools: [], thinkingLevel: 'off', sessionManager: SessionManager.inMemory(cwd),
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off', transport }),
        });
        await session.bindExtensions({ onError: error => errors.push(error) });
        session.subscribe(event => events.push(event));
        try {
          await session.prompt('REAL_USER_SENTINEL');
          if (action === 'abort-cached' || action === 'abort-context-cached') {
            assert.equal(websocketFrames.length, 1);
            assert.equal(session.messages.findLast(message => message.role === 'assistant')?.stopReason, 'stop');
            await session.prompt('REAL_USER_SENTINEL');
          }
          assert.equal(hookCalls, action === 'abort-cached' ? 2 : 1);
          assert(!JSON.stringify(session.messages).includes('OWNED_CARRIER_SENTINEL'));
          assert(!JSON.stringify(session.sessionManager.getEntries()).includes('OWNED_CARRIER_SENTINEL'));
          const assistant = session.messages.findLast(message => message.role === 'assistant');
          assert(assistant);
          if (action === 'abort-context-cached') {
            assert(immediatelyAborted); assert.equal(fetches.length, 0);
            assert.equal(websocketFrames.length, 1); assert.equal(websocketOpens, 1);
            // Early transform cancellation can surface as an error response; the
            // decisive evidence is an aborted run signal and no second transport call.
            assert(['aborted', 'error'].includes(assistant.stopReason)); assert.equal(errors.length, 0);
          } else if (action === 'abort' || action === 'abort-cached') {
            assert(immediatelyAborted);
            assert.equal(fetches.length, 0);
            // Known 0.99.2 host defect: cached sockets send before honoring abort. Reader disables this API.
            assert.equal(websocketOpens, transport === 'sse' ? 0 : 1);
            if (action === 'abort-cached') {
              assert([1, 2].includes(websocketFrames.length)); cachedAbortSafe = websocketFrames.length === 1;
              if (!cachedAbortSafe) assert(JSON.stringify(websocketFrames[1]).includes('OWNED_CARRIER_SENTINEL'));
            } else assert.equal(websocketFrames.length, 0);
            assert.equal(assistant.stopReason, 'aborted');
            assert.equal(errors.length, 0);
          } else {
            assert.equal(fetches.length, transport === 'sse' ? 1 : 0);
            if (transport === 'sse') assert.equal(fetches[0].aborted, false);
            const serialized = JSON.stringify(transport === 'sse' ? fetches[0].body : websocketFrames[0]);
            assert.equal(serialized.includes('OWNED_CARRIER_SENTINEL'), action !== 'replace');
            assert(serialized.includes('EXACT_FORCED_TEXT'));
            assert(serialized.includes('REAL_USER_SENTINEL'));
            assert.equal(errors.length, action === 'throw' ? 1 : 0);
            assert.equal(assistant.stopReason, transport === 'sse' ? 'error' : 'stop');
          }
          assert(session.isIdle);
          assert(events.some(event => event.type === 'agent_settled'));
          console.log(JSON.stringify({ hostVersion, api, transport, action, hookCalls, fetches: fetches.length, websocketOpens,
            websocketFrames: websocketFrames.length, immediatelyAborted, stopReason: assistant.stopReason, swallowedErrors: errors.length }));
        } finally { session.dispose(); }
      }
    }
  }
} finally { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; rmSync(cwd, { recursive: true, force: true }); }
console.log(JSON.stringify({ hostVersion, httpAbortFence: 'verified', codexCachedWebSocketAbortFence: cachedAbortSafe ? 'verified' : 'unsupported', network: 'intercepted' }));
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
