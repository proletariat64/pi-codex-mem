import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Greptile finding (PR #20): two processes must not both break the same
 * stale lock. Spawns real child processes racing to acquire one stale lock.
 * Each child holds the lock briefly before exiting, so a second winner
 * would overlap the hold. Invariant: exactly one winner per round.
 */
function race(lockDir: string, racers: number): Promise<number[]> {
  const configUrl = pathToFileURL(join(process.cwd(), "src", "config.ts")).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(configUrl)};
    const ok = acquireLock(process.env.LOCK_DIR);
    if (!ok) process.exit(2);
    setTimeout(() => process.exit(0), 200); // hold window
  `;
  return Promise.all(
    Array.from({ length: racers }, () =>
      new Promise<number>((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, LOCK_DIR: lockDir },
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("exit", (code) => resolvePromise(code ?? 1));
      }),
    ),
  );
}

test("concurrent stale-lock breakers: exactly one winner per round", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-lockrace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (let round = 0; round < 5; round++) {
    const lock = join(root, `lock-${round}`);
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old); // stale

    const exits = await race(lock, 4);
    const winners = exits.filter((code) => code === 0).length;
    const losers = exits.filter((code) => code === 2).length;
    assert.equal(winners, 1, `round ${round}: expected exactly 1 winner, got ${winners} (exits: ${exits})`);
    assert.equal(losers, 3, `round ${round}: expected 3 clean losers, got ${losers} (exits: ${exits})`);
  }
});
