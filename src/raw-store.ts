import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSensitive } from "./sensitive.ts";

/**
 * Raw event store (spec §5.1): every captured turn writes
 *   raw/YYYY/MM/DD/{identity}/{date}-turn-{turnIndex}-{role}.md   (plaintext mirror)
 *   raw/YYYY/MM/DD/{identity}/{date}-turn-{turnIndex}-{role}.json (redacted evidence + provenance)
 * Dates are timezone-aware (config.timezone). Mirrors hold plaintext;
 * evidence carries redacted text, canary metadata, and the §11.2
 * provenance block.
 */

export interface RawEventCanaries {
  cwdPrefix: boolean;
  cwdSuffix: boolean;
  gitCommit: string;
  artifactPath: string;
  artifactSha256: string;
}

export interface RawEventInput {
  root: string;
  identity: string;
  timezone: string;
  turnIndex: number;
  role: "user" | "assistant";
  texts: string[];
  canaries: RawEventCanaries;
  at?: Date;
}

export interface RawEventPaths {
  mirrorPath: string;
  evidencePath: string;
}

/** YYYY-MM-DD in the configured timezone (spec §5.3). */
export function eventDate(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function buildVerifiedBy(canaries: RawEventCanaries): string[] {
  const verifiedBy: string[] = [];
  if (canaries.cwdPrefix) verifiedBy.push("cwd-prefix");
  if (canaries.cwdSuffix) verifiedBy.push("cwd-suffix");
  if (canaries.gitCommit !== "unknown") verifiedBy.push("git-commit");
  verifiedBy.push("artifact-hash");
  return verifiedBy;
}

export function writeRawEvent(input: RawEventInput): RawEventPaths {
  const at = input.at ?? new Date();
  const date = eventDate(input.timezone, at);
  const [year, month, day] = date.split("-");
  const base = join(
    input.root,
    "raw",
    year!,
    month!,
    day!,
    input.identity,
    `${date}-turn-${input.turnIndex}-${input.role}`,
  );
  const mirrorPath = `${base}.md`;
  const evidencePath = `${base}.json`;
  mkdirSync(join(input.root, "raw", year!, month!, day!, input.identity), { recursive: true });

  // Mirror: plaintext, verbatim (spec §11.2 — redaction never applies here).
  writeFileSync(mirrorPath, input.texts.join("\n") + "\n", { mode: 0o600 });

  const normalized = input.texts.map((t) => t.trim()).join("\n");
  const eventId =
    "evt_" +
    createHash("sha256")
      .update(
        `${input.identity}|${date}|${input.turnIndex}|${input.role}|${normalized}|${input.canaries.artifactSha256}`,
      )
      .digest("hex")
      .slice(0, 16);

  const evidence = {
    schemaVersion: 1,
    eventId,
    identity: input.identity,
    date,
    turnIndex: input.turnIndex,
    role: input.role,
    texts: input.texts.map(redactSensitive),
    canaries: input.canaries,
    provenance: {
      extractionMethod: "canary-verified",
      verifiedBy: buildVerifiedBy(input.canaries),
      canaryPreserved: true,
      extractedAt: at.toISOString(),
    },
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  return { mirrorPath, evidencePath };
}
