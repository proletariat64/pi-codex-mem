import { createHash } from "node:crypto";

const BASE_AGE_MS = 2 * 86_400_000;

/** Render an immutable, linear or branched Pi v3 JSONL source from one case fixture. */
export function buildSessionJsonl(caseId, session, cwd, now, index = 0) {
  const start = now - BASE_AGE_MS + index * 60_000;
  const id = createHash("sha256").update(`${caseId}:${session.id}`).digest("hex").slice(0, 32);
  const entries = [{ type: "session", version: 3, id, cwd, timestamp: new Date(start).toISOString() }];
  let previous = null;
  for (const [offset, message] of session.messages.entries()) {
    const entryId = `${session.id}-${message.id}`;
    const parentId = message.parentId === undefined ? previous : message.parentId === null ? null : `${session.id}-${message.parentId}`;
    const time = start + offset * 1_000 + 1_000;
    const content = [{ type: "text", text: message.text }];
    let actualParent = parentId;
    if (message.role === "tool") {
      // Pi's v3 transcript pairs a tool result with an assistant tool call.
      // The fixture supplies observed output, not an executable command; never infer a command from that output.
      const callId = `call-${entryId}`;
      const callEntryId = `${entryId}-request`;
      entries.push({ type: "message", id: callEntryId, parentId, timestamp: new Date(time - 1).toISOString(),
        message: { role: "assistant", content: [{ type: "toolCall", id: callId,
          name: "bash", arguments: { command: "[fixture command unavailable]" } }], timestamp: time - 1 } });
      actualParent = callEntryId;
    }
    const payload = message.role === "tool"
      ? { role: "toolResult", toolCallId: `call-${entryId}`, toolName: "bash", isError: false, content, timestamp: time }
      : { role: message.role, content, timestamp: time };
    entries.push({ type: "message", id: entryId, parentId: actualParent, timestamp: new Date(time).toISOString(), message: payload });
    previous = entryId;
  }
  return entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
}

export const selectedLeafId = (session) => session.selectedLeaf ? `${session.id}-${session.selectedLeaf}` : undefined;
