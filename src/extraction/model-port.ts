import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryModelPort, MemoryResponse } from "./runner.ts";
import { normalizeModelUsage } from "../model-usage.ts";

/** Capture the owning runtime's provider registry, never its credentials. */
export function createRegistryModelPort(registry: ExtensionContext["modelRegistry"]): MemoryModelPort {
  return {
    resolve(ref) {
      const model = registry.find(ref.provider, ref.modelId);
      if (!model) return undefined;
      return { provider: model.provider, modelId: model.id,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    },
    async request(modelRef, context, options): Promise<MemoryResponse> {
      const model = registry.find(modelRef.provider, modelRef.modelId);
      if (!model) throw new Error("model not found");
      const message = await registry.streamSimple(model, context, options).result();
      const text = message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("");
      return { stopReason: message.stopReason === "pending" ? "error" : message.stopReason,
        text, errorMessage: message.errorMessage,
        usage: normalizeModelUsage(message.usage) };
    },
  };
}
