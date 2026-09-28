import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
function race(lockDir: string, barrierFile: string, racers: number): Promise<number[]> {
  const configUrl = pathToFileURL(join(process.cwd(), "src", "config.ts")).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(configUrl)};
    import { existsSync } from "node:fs";
    // Start barrier: all racers attempt at the same time.
    while (!existsSync(process.env.BARRIER)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const token = acquireLock(process.env.LOCK_DIR);
    if (!token) process.exit(2);
    // Stay ALIVE holding the lock: owner-PID liveness makes the hold
    // unbreakable, so any racer inside this window must lose.
    setTimeout(() => process.exit(0), 1500);
  `;
  return Promise.all(
    Array.from({ length: racers }, () =>
      new Promise<number>((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, LOCK_DIR: lockDir, BARRIER: barrierFile },
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
    const barrier = join(root, `barrier-${round}`);

    const pending = race(lock, barrier, 4);
    // Let all racers reach the barrier, then release them together.
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(barrier, "go");
    const exits = await pending;
    const winners = exits.filter((code) => code === 0).length;
    const losers = exits.filter((code) => code === 2).length;
    assert.equal(winners, 1, `round ${round}: expected exactly 1 winner, got ${winners} (exits: ${exits})`);
    assert.equal(losers, 3, `round ${round}: expected 3 clean losers, got ${losers} (exits: ${exits})`);
  }
});
