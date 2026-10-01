import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";

import { MEMORY_CARRIER_TYPE } from "./carrier.ts";
const legacyMemory = (text: string) => text.includes("historical_memory_evidence") &&
  (text.includes("## Pi Memory") || text.includes("Memory version:"));

/** Old opaque system policy must not be destructively spliced. */
export function hasUnsafeMemoryResidue(messages: AgentMessage[]): boolean {
  return messages.some(message => {
    if (message.role === "custom" && message.customType === MEMORY_CARRIER_TYPE) return false;
    if (message.role !== "system" && message.role !== "custom") return false;
    const content = message.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return legacyMemory(text) || (message.role === "system" && legacyMemory(JSON.stringify(message.sections ?? {})));
  });
}

/** Fresh request array; remove only attributed carriers/named sections, never opaque policy text. */
export function projectMemoryMessages(messages: AgentMessage[], text: string | null): AgentMessage[] {
  const fresh = messages.filter(message => !(message.role === "custom" && message.customType === MEMORY_CARRIER_TYPE))
    .map(message => {
      if (message.role !== "system" || !message.sections || !(MEMORY_CARRIER_TYPE in message.sections)) return message;
      const sections = { ...message.sections }; delete sections[MEMORY_CARRIER_TYPE];
      return { ...message, sections };
    });
  if (text !== null) fresh.splice(fresh[0]?.role === "system" ? 1 : 0, 0, {
    role: "custom", customType: MEMORY_CARRIER_TYPE, content: text, display: false,
    // Stable non-semantic host field; timestamps are not part of model-visible evidence.
    timestamp: 0,
  });
  return fresh;
}

interface PayloadRecord { [key: string]: unknown }
const record = (value: unknown): value is PayloadRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) return null;
  return typeof value[0].text === "string" && ["text", "input_text"].includes(String(value[0].type)) ? value[0].text : null;
};

/** Supported effective provider message envelopes. No arbitrary deep deletion of policy/control data. */
export function removeProviderCarrier(payload: unknown, fingerprints: ReadonlySet<string>): { safe: boolean; payload: unknown; removed: number } {
  if (!record(payload)) return { safe: false, payload, removed: 0 };
  const key = Array.isArray(payload.messages) ? "messages" : Array.isArray(payload.input) ? "input"
    : Array.isArray(payload.contents) ? "contents" : null;
  if (!key) return { safe: false, payload, removed: 0 };
  let removed = 0;
  const messages = (payload[key] as unknown[]).filter(message => {
    if (!record(message) || message.role !== "user") return true;
    const content = key === "contents" ? message.parts : message.content;
    const text = key === "contents" && Array.isArray(content) && content.length === 1 && record(content[0])
      && Object.keys(content[0]).length === 1 && typeof content[0].text === "string" ? content[0].text : textOf(content);
    // Removing a merged human+memory message or a message containing tool/control state is not safe.
    const allowedKeys = key === "contents" ? ["role", "parts"] : ["role", "content", "type"];
    if (text !== null && fingerprints.has(createHash("sha256").update(text).digest("hex")) && Object.keys(message).every(field => allowedKeys.includes(field))) {
      removed++; return false;
    }
    return true;
  });
  const replacement = { ...payload, [key]: messages };
  const residue = messages.some(message => record(message) && message.role === "user" &&
    legacyMemory(JSON.stringify(key === "contents" ? message.parts : message.content)));
  return { safe: !residue, payload: replacement, removed };
}

export function providerHasLegacyResidue(payload: unknown): boolean {
  if (!record(payload)) return false;
  const system = [payload.system, payload.instructions, payload.systemInstruction];
  if (Array.isArray(payload.messages)) system.push(...payload.messages.filter(message => record(message) &&
    (message.role === "system" || message.role === "developer")));
  return system.some(value => value !== undefined && legacyMemory(JSON.stringify(value)));
}

/** Conservative upper input units: UTF-8 bytes plus explicit framing overhead. */
export function requestCapacity(messages: AgentMessage[], contextWindow: number | undefined, maxOutput: number | undefined): number | null {
  if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput) || contextWindow! <= 0 || maxOutput! <= 0) return null;
  const tools = getCurrentTools(messages);
  // Transcript declarations may also expand into provider-level tool envelopes.
  // Reserve their complete effective serialization plus per-tool framing, rather
  // than assuming the fixed request reserve covers arbitrarily large tool sets.
  const toolOverhead = tools.length ? Buffer.byteLength(JSON.stringify(tools), "utf8") + tools.length * 256 : 0;
  return Math.max(0, Math.floor(contextWindow! - maxOutput! - Buffer.byteLength(JSON.stringify(messages), "utf8") - toolOverhead - 1024));
}
