// Host compatibility check (spec §2.3). Pure predicates over a probed
// capability object; registration alone does not establish event support
// or an effective pre-send cancellation fence.

export const REQUIRED_EVENTS = [
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_tree",
  "session_shutdown",
  "before_agent_start",
  "context_with_system",
  "before_provider_request",
  "agent_start",
  "agent_before_settle",
  "agent_settled",
] as const;

export type RequiredEvent = (typeof REQUIRED_EVENTS)[number];

export interface HostCapabilities {
  /** e.g. process.versions.node */
  nodeVersion: string;
  /** Actual host version, not this package's dev dependency version. */
  piVersion: string;
  hasNodeSqlite: boolean;
  /** Verified events; registering an unknown name does not prove support. */
  events: readonly string[];
  /** ctx.abort plus native signal enforcement before transport; not a caught throw. */
  hasNativeRunAbort: boolean;
  /** Request projection preserves the leading system and other extensions' policy. */
  hasLeadingSystemPreservation: boolean;
  /** Effective declarations and tool call/result pairs survive request projection. */
  hasToolPreservation: boolean;
  /** @deprecated Revision 4 does not require or use section injection. */
  hasStructuredPromptSections?: boolean;
  /** ctx.sessionManager.getBranch is available. */
  hasBranchAccess: boolean;
  /** ctx.modelRegistry.find + streamSimple are available. */
  hasModelRegistryAccess: boolean;
}

export interface CompatResult {
  supported: boolean;
  problems: string[];
}

export const MIN_NODE_VERSION = "22.19.0";

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Shared semver-ish comparator used for both Node and pi host versions. */
export function semverAtLeast(version: string, minimum: string): boolean {
  const v = parseVersion(version);
  const min = parseVersion(minimum);
  if (!v || !min) return false;
  for (let i = 0; i < 3; i++) {
    const a = v[i]!;
    const b = min[i]!;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Unsupported hosts disable memory with a diagnostic (spec §2.3), never
 * silently reverting to system-section injection or older event semantics.
 * These predicates do not replace the target-host abort/transport tests.
 */
export function checkHostCompat(caps: HostCapabilities): CompatResult {
  const problems: string[] = [];
  if (!semverAtLeast(caps.nodeVersion, MIN_NODE_VERSION)) {
    problems.push(`Node ${caps.nodeVersion} is below the required >= ${MIN_NODE_VERSION}`);
  }
  if (!caps.hasNodeSqlite) {
    problems.push("node:sqlite is not available in this Node runtime");
  }
  for (const event of REQUIRED_EVENTS) {
    if (!caps.events.includes(event)) {
      problems.push(`host does not support the "${event}" extension event (required capability; registration alone cannot detect this)`);
    }
  }
  if (!caps.hasNativeRunAbort) {
    problems.push("host lacks native whole-run abort with a pre-transport signal fence (ctx.abort); caught handler exceptions cannot cancel dispatch");
  }
  if (!caps.hasLeadingSystemPreservation) {
    problems.push("host lacks leading system and extension-policy preservation during request projection");
  }
  if (!caps.hasToolPreservation) {
    problems.push("host lacks effective tool declaration and tool call/result preservation during request projection");
  }
  if (!caps.hasBranchAccess) {
    problems.push("host lacks session branch access (ctx.sessionManager.getBranch)");
  }
  if (!caps.hasModelRegistryAccess) {
    problems.push("host lacks model registry access (ctx.modelRegistry.find/streamSimple)");
  }
  return { supported: problems.length === 0, problems };
}
