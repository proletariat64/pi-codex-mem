import type { Usage } from "@earendil-works/pi-ai";

/** Pi reports uncached, cache-read, and cache-write inputs as disjoint counts.
 * cacheWrite1h is a subset of cacheWrite; totalTokens also includes output. */
export function normalizeModelUsage(usage: Usage | undefined): { input: number; output: number } | undefined {
  if (!usage) return undefined;
  const parts = [usage.input, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.output];
  if (parts.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isSafeInteger(input) ? { input, output: usage.output } : undefined;
}
