import { setTimeout as delay } from "node:timers/promises";

// An evaluation uses a fresh, single-version store. Keep all attempts in the
// trace, but only count terminal jobs toward the expected source count.
export async function finishExtractions({ extractor, db, expected, now = Date.now, sleep = delay }) {
  const attempts = [];
  for (let pass = 0; pass < expected * 8; pass++) {
    const batch = await extractor.runPass(true);
    attempts.push(...batch);
    const jobs = db.prepare("SELECT status, due_at, attempt_count, error_code FROM jobs WHERE kind = 'extract'").all();
    if (jobs.length !== expected) throw new Error(`Extraction job count mismatch: ${jobs.length}/${expected}`);
    if (jobs.every(job => ["succeeded", "no_output"].includes(job.status))) return attempts;
    if (jobs.some(job => !["succeeded", "no_output", "retry_wait", "queued"].includes(job.status)))
      throw new Error(`Extraction did not complete: ${JSON.stringify(jobs)}`);
    const pending = jobs.filter(job => !["succeeded", "no_output"].includes(job.status));
    if (pending.some(job => job.attempt_count >= 3))
      throw new Error(`Extraction retry limit reached: ${JSON.stringify(pending)}`);
    const next = Math.min(...pending.map(job => job.due_at));
    const wait = Math.max(0, next - now());
    if (wait > 300_000) throw new Error(`Extraction retry delay exceeds five minutes: ${wait}ms`);
    if (wait) await sleep(wait + 25);
  }
  throw new Error(`Extraction pass limit reached: ${JSON.stringify(attempts)}`);
}
