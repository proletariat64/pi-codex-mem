/**
 * Minimal sensitive-info sink (spec §11.2: redact normalized evidence
 * before persisting a source snapshot; no plaintext raw mirror exists).
 * Hardened further in the policy/filter ticket (#12).
 */

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\bghp_[A-Za-z0-9]{30,}\b/g, // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{30,}\b/g, // GitHub OAuth tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Replace recognized secret shapes with [REDACTED]. */
const SECRET_QUERY_KEY = /^(?:x-amz-(?:signature|credential|security-token|algorithm)|x-goog-(?:signature|credential)|signature|sharedaccesssignature|sig|se|sp|sv|token|(?:access|refresh|id|session)[_-]?token|client[_-]?secret|private[_-]?key|password|authorization|auth|api[_-]?key|key)$/i;

export function redactSensitive(text: string): string {
  // Preserve the useful host/path but never persist signed or access-bearing
  // query values. URL parsing handles encoded parameter names and case.
  let out = text.replace(/https?:\/\/[^\s<>"']+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      if (![...url.searchParams.keys()].some((key) => SECRET_QUERY_KEY.test(key))) return candidate;
      return `${url.origin}${url.pathname}[REDACTED signed URL query]`;
    } catch {
      return "[REDACTED malformed URL]";
    }
  });
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
