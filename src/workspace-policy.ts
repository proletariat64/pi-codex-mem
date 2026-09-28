import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Spec §14: path exclusion is canonical and directory-boundary aware. */
export function isExcludedWorkspace(cwd: string, excludedPaths: readonly string[]): boolean {
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const active = canonical(cwd);
  return excludedPaths.some((path) => {
    const excluded = canonical(path);
    return active === excluded || active.startsWith(excluded.endsWith(sep) ? excluded : excluded + sep);
  });
}
