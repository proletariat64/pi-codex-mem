/**
 * Minimal sensitive-info sink (spec §11.2: redaction applies to evidence,
 * never to the raw mirror; never persist sensitive info into evidence).
 * Hardened further in the policy/filter ticket (#12).
 */

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\bghp_[A-Za-z0-9]{30,}\b/g, // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{30,}\b/g, // GitHub OAuth tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace recognized secret shapes with [REDACTED]. */
export function redactSensitive(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
