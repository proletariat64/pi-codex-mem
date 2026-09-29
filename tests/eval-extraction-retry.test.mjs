import { test } from "node:test";
import assert from "node:assert/strict";
import { finishExtractions } from "../eval/extraction-retry.mjs";

test("transient provider failure retries the same extraction slot after its due time", async () => {
  let time = 1000;
  let pass = 0;
  const job = { status: "queued", due_at: 1000, attempt_count: 0, error_code: null };
  const waits = [];
  const attempts = await finishExtractions({
    extractor: { runPass: async () => {
      pass++;
      if (pass === 1) {
        Object.assign(job, { status: "retry_wait", due_at: time + 60_000, attempt_count: 1, error_code: "provider_error" });
        return [{ status: "retry_wait" }];
      }
      assert.ok(time >= job.due_at);
      job.status = "succeeded";
      return [{ status: "succeeded" }];
    } },
    db: { prepare: () => ({ all: () => [{ ...job }] }) }, expected: 1,
    now: () => time, sleep: async ms => { waits.push(ms); time += ms; },
  });
  assert.deepEqual(attempts.map(value => value.status), ["retry_wait", "succeeded"]);
  assert.deepEqual(waits, [60_025]);
});

test("blocked and unbounded retry states fail instead of disguising a missing answer", async () => {
  for (const job of [
    { status: "blocked", due_at: 0, attempt_count: 3 },
    { status: "retry_wait", due_at: 999_999, attempt_count: 1 },
  ]) {
    await assert.rejects(finishExtractions({
      extractor: { runPass: async () => [{ status: job.status }] },
      db: { prepare: () => ({ all: () => [job] }) }, expected: 1,
      now: () => 0, sleep: async () => assert.fail("unexpected sleep"),
    }), /Extraction did not complete|delay exceeds/);
  }
});
