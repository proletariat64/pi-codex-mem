/**
 * Codex model-visible context accounting, mapped onto Pi's normalized messages.
 *
 * Upstream reference (pinned, not a moving branch):
 *   openai/codex@1cc7e2361237ce7244430ee1d581c77f95c57ac8
 *   codex-rs/utils/string/src/truncate.rs::approx_token_count
 *   codex-rs/core/src/context_manager/history.rs::get_total_token_usage
 *   codex-rs/core/src/context_manager/history.rs::estimate_item_token_count
 *
 * The only host adaptation here is the conversion of Pi's message/tool shape
 * into Codex's model-visible text/items. Do not count the outer JSON envelope,
 * transport metadata, duplicated tool-result details or escaped text syntax.
 */

const BYTES_PER_TOKEN = 4;
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** Exact arithmetic port of Codex's UTF-8 approximation (not a tokenizer). */
export function approxTokenCount(text: string): number {
  return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

const bytes = (value: unknown): number => typeof value === "string" ? byteLength(value) : 0;
function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : byteLength(encoded);
}

function contentBytes(content: unknown): number {
  if (typeof content === "string") return byteLength(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const element of content) {
    const part = record(element);
    if (!part) continue;
    switch (part.type) {
      case "text":
        total += bytes(part.text);
        break;
      case "thinking":
        // Only included when Pi's normalized transport replays the text.
        total += bytes(part.thinking);
        break;
      case "toolCall":
        // Codex FunctionCall accounting: name + serialized JSON arguments.
        total += bytes(part.name) + jsonBytes(part.arguments);
        break;
      case "image":
      case "audio":
        // Never interpret encoded image/audio bytes as UTF-8 prompt tokens.
        throw new Error("non_text_context_unsupported");
      default:
        break;
    }
  }
  return total;
}

/** Codex-style item estimate after translating one normalized Pi message. */
export function estimatePiMessageTokens(messageValue: unknown): number {
  const message = record(messageValue);
  if (!message) throw new Error("invalid_model_message");
  let visible = contentBytes(message.content);
  if (message.role === "toolResult") {
    // These fields are present in Codex's function-output history items.
    visible += bytes(message.toolCallId) + bytes(message.toolName);
  }
  return Math.ceil(visible / BYTES_PER_TOKEN);
}

/**
 * Initial/unknown-usage fallback: estimate only provider-visible content.
 * Pi exposes tool declarations separately from message history; they are
 * counted once at the request boundary, never duplicated per message.
 */
export function estimateModelVisibleTokens(context: unknown): number {
  const request = record(context);
  if (!request || !Array.isArray(request.messages)) throw new Error("invalid_model_context");
  let visible = bytes(request.systemPrompt);
  for (const rawMessage of request.messages) {
    const message = record(rawMessage);
    if (!message) throw new Error("invalid_model_message");
    visible += contentBytes(message.content);
    if (message.role === "toolResult") visible += bytes(message.toolCallId) + bytes(message.toolName);
  }
  // Pi's context_with_system carrier can embed tool declarations as
  // system-message toolsAdded instead of supplying a top-level tools array.
  // Deduplicate names when both representations are present in the projection.
  const tools = new Map<string, Record<string, unknown>>();
  const addTools = (source: unknown) => {
    if (source === undefined) return;
    if (!Array.isArray(source)) throw new Error("invalid_model_tools");
    for (const rawTool of source) {
      const tool = record(rawTool);
      if (!tool || typeof tool.name !== "string") throw new Error("invalid_model_tool");
      tools.set(tool.name, tool);
    }
  };
  for (const rawMessage of request.messages) {
    const message = record(rawMessage);
    if (message?.role === "system") addTools(message.toolsAdded);
  }
  addTools(request.tools);
  for (const tool of tools.values()) {
    visible += bytes(tool.name) + bytes(tool.description) + jsonBytes(tool.parameters);
  }
  return Math.ceil(visible / BYTES_PER_TOKEN);
}

/**
 * After a provider-reported usage sample, Codex adds only items appended
 * since the most recent model message (normally workspace tool results).
 * The provider has already counted prior instructions, tools and messages.
 * Caller falls back to full estimation if provider usage is unavailable.
 */
export function estimatedTokensAfterLastAssistant(context: unknown): number {
  const request = record(context);
  if (!request || !Array.isArray(request.messages)) throw new Error("invalid_model_context");
  const messages: unknown[] = request.messages;
  let lastAssistant = -1;
  for (let i = 0; i < messages.length; i++) {
    if (record(messages[i])?.role === "assistant") lastAssistant = i;
  }
  if (lastAssistant < 0) return estimateModelVisibleTokens(context);
  return messages.slice(lastAssistant + 1).reduce<number>((total, item) =>
    total + estimatePiMessageTokens(item), 0);
}
