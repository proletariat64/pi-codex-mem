import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "../config.ts";

export interface ConsolidationModelPort {
  resolve(ref: ModelRef): Model<Api> | undefined;
  stream: StreamFn;
}

/** Retain only the owning runtime's registry closure, never provider credentials. */
export function createConsolidationModelPort(registry: ExtensionContext["modelRegistry"]): ConsolidationModelPort {
  return {
    resolve: (ref) => registry.find(ref.provider, ref.modelId),
    stream: (model, context, options) => registry.streamSimple(model, context, options),
  };
}
