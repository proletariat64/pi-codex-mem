import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "../config.ts";
import type { MatchingTokenCounter, NormalizedRequest, TokenCounterIdentity } from "./context-controller.ts";

/** Result of the optional matching-counter seam: tokens plus the tokenizer's own identity. */
export interface ConsolidationTokenCount {
  tokens: number;
  /** Assert the resolved model/API and full counting/framing policy version.
   * The controller compares all assertions with its captured model and policy;
   * missing/mismatched assertions are calibrated estimates, not exact counts. */
  counterIdentity: TokenCounterIdentity;
}

export interface ConsolidationModelPort {
  resolve(ref: ModelRef): Model<Api> | undefined;
  stream: StreamFn;
  /** Optional matching-counter seam (spec §3.1). Adapters declare their tokenizer identity. */
  countTokens?(model: Model<Api>, request: NormalizedRequest): ConsolidationTokenCount | undefined;
}

/** Retain only the owning runtime's registry closure, never provider credentials. */
export function createConsolidationModelPort(registry: ExtensionContext["modelRegistry"]): ConsolidationModelPort {
  return {
    resolve: (ref) => registry.find(ref.provider, ref.modelId),
    stream: (model, context, options) => registry.streamSimple(model, context, options),
  };
}

/** Adapt the port's optional countTokens seam into a controller counter for one resolved model. */
export function tokenCounterForModel(port: ConsolidationModelPort, model: Model<Api>): MatchingTokenCounter | undefined {
  if (!port.countTokens) return undefined;
  return {
    count: (request) => {
      const result = port.countTokens!(model, request);
      if (!result) return undefined;
      const { counterIdentity } = result;
      return { tokens: result.tokens, identity: counterIdentity };
    },
  };
}
