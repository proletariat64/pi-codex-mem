import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Greptile findings (PR #20/#21): concurrent stale-lock breakers must
 * produce exactly one winner, and the test must not flake when a contender
 * is slow. Synchronization is explicit, not timing-based:
 *  - every child writes ready-<i> after spawn setup, then waits at a barrier
 *  - the parent releases the barrier only after ALL children are ready
 *  - after its attempt each child writes done-<i>
 *  - the winner stays alive (owner PID live → lock unbreakable) until every
 *    contender's done-<i> exists, then exits
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFiles(dir: string, prefix: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = Array.from({ length: count }, (_, i) => existsSync(join(dir, `${prefix}-${i}`))).filter(Boolean)
      .length;
    if (found === count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${prefix} files (got ${found})`);
    await sleep(20);
  }
}

function race(lockDir: string, dir: string, racers: number): Promise<number[]> {
  const configUrl = pathToFileURL(join(process.cwd(), "src", "config.ts")).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(configUrl)};
    import { writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const dir = process.env.RACE_DIR;
    const me = process.env.RACE_ID;
    writeFileSync(join(dir, "ready-" + me), "1");
    while (!existsSync(join(dir, "barrier"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const token = acquireLock(process.env.LOCK_DIR);
    writeFileSync(join(dir, "done-" + me), token ? "won" : "lost");
    if (!token) process.exit(2);
    // Winner: hold (alive) until every contender's attempt has completed.
    const n = Number(process.env.RACE_N);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      let done = 0;
      for (let i = 0; i < n; i++) if (existsSync(join(dir, "done-" + i))) done++;
      if (done === n) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    process.exit(0);
  `;
  return Promise.all(
    Array.from({ length: racers }, (_, i) =>
      new Promise<number>((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, LOCK_DIR: lockDir, RACE_DIR: dir, RACE_ID: String(i), RACE_N: String(racers) },
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
    const dir = join(root, `round-${round}`);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old); // stale (ownerless + old)

    const racers = 4;
    const pending = race(lock, dir, racers);
    await waitForFiles(dir, "ready", racers, 15000); // no timing assumptions
    writeFileSync(join(dir, "barrier"), "go");
    const exits = await pending;
    const winners = exits.filter((code) => code === 0).length;
    const losers = exits.filter((code) => code === 2).length;
    assert.equal(winners, 1, `round ${round}: expected exactly 1 winner, got ${winners} (exits: ${exits})`);
    assert.equal(losers, racers - 1, `round ${round}: expected ${racers - 1} clean losers (exits: ${exits})`);
  }
});
