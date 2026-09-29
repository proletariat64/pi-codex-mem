export type ExtractionVersion = "v1" | "v2";

/** Codex Responses JSON-schema mode; the host still validates every returned field. */
export function codexExtractionFormat(version: ExtractionVersion) {
  const fields = version === "v1"
    ? ["raw_memory", "rollout_summary", "rollout_slug"]
    : ["rollout_summary", "rollout_slug"];
  return {
    type: "json_schema" as const,
    name: `pi_memory_extraction_${version}`,
    strict: true,
    schema: {
      type: "object" as const,
      properties: Object.fromEntries(fields.map(field => [field, { type: "string" }])),
      required: fields,
      additionalProperties: false,
    },
  };
}

export interface CodexPayloadWithFormat {
  text: Record<string, unknown> & { format: ReturnType<typeof codexExtractionFormat> };
  [key: string]: unknown;
}

export function withCodexExtractionFormat(payload: unknown, version: ExtractionVersion): CodexPayloadWithFormat {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Codex request payload is not an object");
  }
  const body = payload as Record<string, unknown>;
  const text = body.text && typeof body.text === "object" && !Array.isArray(body.text)
    ? body.text as Record<string, unknown> : {};
  return { ...body, text: { ...text, format: codexExtractionFormat(version) } };
}
