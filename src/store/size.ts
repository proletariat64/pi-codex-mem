import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Approximate owned-store usage for the `limits.maxStoreBytes` cap:
 * sources/, versions/, notes/ and SQLite files under the memory root.
 * Symlinked names are skipped, never followed; an unreadable root measures
 * as zero so the cap can never disable memory by measurement failure alone.
 */
export function storeSizeBytes(root: string): number {
  let names: string[];
  try { names = readdirSync(root); } catch { return 0; }
  let total = 0;
  for (const name of names) {
    let stat;
    try { stat = lstatSync(join(root, name)); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += storeSizeBytes(join(root, name));
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}
