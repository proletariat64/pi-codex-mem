import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "node:test";

const root = resolve(import.meta.dirname, "..");
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : /\.test\.(?:mjs|ts)$/.test(entry.name) ? [path] : [];
  }).sort();
}

// One row is required per version, not one test that loops over both versions.
const expected = new Map();
for (let n = 1; n <= 22; n++) {
  for (const version of ["v1", "v2"]) expected.set(`T${String(n).padStart(2, "0")} ${version}`, null);
}
for (let n = 23; n <= 38; n++) {
  const version = n <= 27 || n === 36 ? "v2" : "cross";
  expected.set(`T${n} ${version}`, null);
}

const duplicates = [];
const unrelatedFailures = [];
const invalidLabels = [];
const label = /^\[?(T\d{2} (?:v1|v2|cross))\]?(?=\s|:|$)/;
// A hung child must fail rather than hold the gate (and the host) indefinitely.
const stream = run({ files: testFiles(join(root, "tests")), concurrency: 1, timeout: 120_000 });
for await (const { type, data } of stream) {
  if (!["test:pass", "test:fail", "test:skip", "test:todo"].includes(type)) continue;
  const match = label.exec(data.name);
  if (!match) {
    if (type === "test:fail") unrelatedFailures.push(`${data.file ?? "unknown"}: ${data.name}: ${data.details?.error?.message ?? "failed"}`);
    continue;
  }
  const key = match[1];
  if (!expected.has(key)) { invalidLabels.push(key); continue; }
  if (expected.get(key) !== null) { duplicates.push(key); continue; }
  expected.set(key, { status: type.slice(5), file: data.file });
}

for (const [key, result] of expected) {
  console.log(`${key}: ${result?.status ?? "MISSING"}${result?.file ? ` (${result.file.replace(`${root}/`, "")})` : ""}`);
}
const missing = [...expected.values()].filter(value => value === null).length;
const failed = [...expected.values()].filter(value => value && value.status !== "pass").length;
console.log(`Matrix: ${expected.size - missing - failed}/${expected.size} passed; ${missing} missing; ${failed} failed/skipped`);
for (const failure of unrelatedFailures) console.error(`Unrelated test failure: ${failure}`);
for (const key of duplicates) console.error(`Duplicate matrix label: ${key}`);
for (const key of invalidLabels) console.error(`Unexpected matrix label: ${key}`);
if (missing || failed || unrelatedFailures.length || duplicates.length || invalidLabels.length) process.exitCode = 1;
