// Host compatibility check (spec §2.3). Pure predicates over a probed
// capability object so the check is unit-testable; the extension adapter
// gathers the real capabilities from pi and Node at session_start.

export const REQUIRED_EVENTS = [
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_tree",
  "session_shutdown",
  "before_agent_start",
  "agent_start",
  "agent_before_settle",
  "agent_settled",
  "input",
  "turn_end",
] as const;

export type RequiredEvent = (typeof REQUIRED_EVENTS)[number];

export interface HostCapabilities {
  /** e.g. process.versions.node */
  nodeVersion: string;
  hasNodeSqlite: boolean;
  /** Events the host accepted handler registration for. */
  events: readonly string[];
  hasStructuredPromptSections: boolean;
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
/** Event support is pinned by host version (registration never throws). */
export const MIN_PI_VERSION = "0.87.1";

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
 * Check a probed host. Unsupported hosts must disable memory behavior with
 * one diagnostic (spec §2.3) — never silently use older event semantics.
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
      problems.push(`host does not support the "${event}" extension event (inferred from pi version < ${MIN_PI_VERSION}; registration alone cannot detect this)`);
    }
  }
  if (!caps.hasStructuredPromptSections) {
    problems.push("host lacks structured system prompt sections (before_agent_start systemPromptOptions.sections)");
  }
  if (!caps.hasBranchAccess) {
    problems.push("host lacks session branch access (ctx.sessionManager.getBranch)");
  }
  if (!caps.hasModelRegistryAccess) {
    problems.push("host lacks model registry access (ctx.modelRegistry.find/streamSimple)");
  }
  return { supported: problems.length === 0, problems };
}
