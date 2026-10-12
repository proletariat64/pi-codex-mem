import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
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

/**
 * ExtensionContext exposes ModelRegistry, not its private ModelRuntime. Adapt
 * only the public model/auth facade used by an isolated, fixed-model session.
 * Authentication still happens at request time in port.stream; no credentials
 * are copied, refreshed or written by this adapter. Virtual routing is unsupported.
 */
export function createWriterRuntime(port: ConsolidationModelPort, model: Model<Api>, stream: StreamFn): ModelRuntime {
  const find = (provider: string, id: string) => port.resolve({ provider, modelId: id });
  const runtime = {
    getModel: find,
    getPhysicalModel: find,
    getAvailableSnapshot: () => [model],
    getError: () => undefined,
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getAuth: async () => undefined,
    checkAuth: async () => undefined,
    streamSimple: stream,
    resolveModel: async () => { throw new Error("Writer registry adapter does not support virtual routing"); },
  };
  // The SDK requires the concrete class although this fixed-model path only uses
  // the public methods above. Integration tests exercise the real SDK contract.
  return runtime as unknown as ModelRuntime;
}
