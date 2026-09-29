import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("./cases.json", import.meta.url));
let cases;
try { cases = JSON.parse(readFileSync(path, "utf8")); }
catch (error) { console.error(`Cannot load ${path}: ${error}`); process.exit(1); }
const counts = { decision: 0, preference: 0, failure: 0, correction: 0, abstention: 0 };
const prefixes = { decision: "D", preference: "P", failure: "F", correction: "C", abstention: "N" };
const ids = new Set();
let multilingual = 0;
let noTools = 0;
const nonempty = (value, name) => assert.ok(typeof value === "string" && value.trim(), `${name} must be nonempty`);

assert.ok(Array.isArray(cases), "cases.json must be an array");
for (const [index, item] of cases.entries()) {
  assert.ok(item && typeof item === "object" && !Array.isArray(item), `case ${index} must be an object`);
  const prefix = prefixes[item.category];
  assert.ok(prefix, `${item.id ?? index}: invalid category`);
  nonempty(item.id, `case ${index} id`);
  assert.match(item.id, new RegExp(`^${prefix}\\d{2}$`));
  assert.ok(!ids.has(item.id), `${item.id}: duplicate id`);
  ids.add(item.id);
  counts[item.category]++;
  assert.ok(["en", "zh", "mixed"].includes(item.language), `${item.id}: invalid language`);
  if (item.language !== "en") multilingual++;
  nonempty(item.query, `${item.id} query`);
  nonempty(item.queryIntent, `${item.id} queryIntent`);
  nonempty(item.curatedSummary, `${item.id} curatedSummary`);
  assert.ok(Buffer.byteLength(item.curatedSummary, "utf8") < 10_000, `${item.id}: curated summary exceeds injection budget`);
  assert.equal(typeof item.abstainWhenMissing, "boolean", `${item.id}: abstainWhenMissing must be boolean`);
  assert.ok(Array.isArray(item.sourceSessions) && item.sourceSessions.length > 0, `${item.id}: missing source sessions`);
  const pointers = new Set();
  const activePointers = new Set();
  const sessionIds = new Set();
  let hasTool = false;
  for (const session of item.sourceSessions) {
    nonempty(session.id, `${item.id} source session id`);
    assert.ok(!sessionIds.has(session.id), `${item.id}: duplicate source session ${session.id}`);
    sessionIds.add(session.id);
    assert.ok(Array.isArray(session.messages) && session.messages.length > 0, `${item.id}: empty source session`);
    const seenMessages = new Set();
    const parents = new Set();
    const parentOf = new Map();
    let previous = null;
    for (const message of session.messages) {
      nonempty(message.id, `${item.id}/${session.id} message id`);
      assert.ok(!seenMessages.has(message.id), `${item.id}: duplicate message ${message.id}`);
      const parent = message.parentId === undefined ? previous : message.parentId;
      assert.ok(parent === null || seenMessages.has(parent), `${item.id}: missing/out-of-order parent ${parent}`);
      if (parent !== null) parents.add(parent);
      parentOf.set(message.id, parent);
      seenMessages.add(message.id);
      previous = message.id;
      assert.ok(["user", "assistant", "tool"].includes(message.role), `${item.id}: invalid role`);
      nonempty(message.text, `${item.id}/${session.id}/${message.id} text`);
      hasTool ||= message.role === "tool";
      const pointer = `${session.id}:${message.id}`;
      assert.ok(!pointers.has(pointer), `${item.id}: duplicate pointer ${pointer}`);
      pointers.add(pointer);
    }
    const leaves = [...seenMessages].filter(id => !parents.has(id));
    if (leaves.length > 1) assert.ok(session.selectedLeaf, `${item.id}: branched session needs selectedLeaf`);
    if (session.selectedLeaf) assert.ok(leaves.includes(session.selectedLeaf), `${item.id}: selectedLeaf is not a leaf`);
    let ancestor = session.selectedLeaf ?? leaves[0];
    while (ancestor !== null) {
      activePointers.add(`${session.id}:${ancestor}`);
      ancestor = parentOf.get(ancestor);
    }
  }
  if (item.forgetBeforeAnswer !== undefined) {
    assert.equal(item.category, "abstention", `${item.id}: forget fixture must test abstention`);
    assert.ok(Array.isArray(item.forgetBeforeAnswer) && item.forgetBeforeAnswer.length > 0 &&
      item.forgetBeforeAnswer.length < item.sourceSessions.length, `${item.id}: forget fixture must retain another source`);
    for (const id of item.forgetBeforeAnswer) assert.ok(sessionIds.has(id), `${item.id}: nonexistent forgotten session ${id}`);
    assert.equal(new Set(item.forgetBeforeAnswer).size, item.forgetBeforeAnswer.length, `${item.id}: duplicate forgotten session`);
  }
  if (!hasTool) noTools++;
  assert.ok(Array.isArray(item.expectedFacts) && item.expectedFacts.length > 0, `${item.id}: no answer key`);
  for (const fact of item.expectedFacts) {
    nonempty(fact.claim, `${item.id} expected fact`);
    assert.ok(Array.isArray(fact.support) && fact.support.length > 0, `${item.id}: fact missing evidence pointers`);
    for (const pointer of fact.support) {
      assert.ok(pointers.has(pointer), `${item.id}: nonexistent support ${pointer}`);
      assert.ok(activePointers.has(pointer), `${item.id}: discarded-branch support ${pointer}`);
    }
  }
  assert.ok(Array.isArray(item.prohibitedClaims) && item.prohibitedClaims.length > 0, `${item.id}: no prohibited claims`);
  for (const claim of item.prohibitedClaims) {
    nonempty(claim.claim, `${item.id} prohibited claim`);
    assert.ok(["critical", "ordinary"].includes(claim.severity), `${item.id}: invalid prohibition severity`);
  }
}
assert.deepEqual(counts, { decision: 10, preference: 5, failure: 5, correction: 5, abstention: 5 });
assert.ok(multilingual >= 10, `only ${multilingual} Chinese/mixed cases`);
assert.ok(noTools >= 5, `only ${noTools} zero-tool cases`);
console.log(`Validated ${cases.length} cases: ${JSON.stringify(counts)}; ${multilingual} zh/mixed; ${noTools} no-tool`);
