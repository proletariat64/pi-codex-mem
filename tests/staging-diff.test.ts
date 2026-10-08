import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceDiff } from "../src/pipeline/staging.ts";

/** Builds a document of numbered lines, optionally replacing one line (1-based). */
const numbered = (count: number, edit?: { line: number; text: string }): string => {
  const lines = Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(4, "0")}`);
  if (edit) lines[edit.line - 1] = edit.text;
  return lines.map((line) => line + "\n").join("");
};

test("a one-line edit to a large baseline file produces a local hunk, not whole-file replacement", () => {
  const prior = new Map([["MEMORY.md", numbered(100)]]);
  const next = new Map([["MEMORY.md", numbered(100, { line: 50, text: "line 0050 edited" })]]);
  const diff = workspaceDiff(prior, next);
  assert.equal(diff.fallback, false);
  assert.deepEqual(diff, { text: diff.text, fallback: false, reason: null });
  assert.equal(
    diff.text,
    [
      "# Workspace changes",
      "",
      "- modified: MEMORY.md",
      "",
      "--- a/MEMORY.md",
      "+++ b/MEMORY.md",
      "@@ -47,7 +47,7 @@",
      " line 0047",
      " line 0048",
      " line 0049",
      "-line 0050",
      "+line 0050 edited",
      " line 0051",
      " line 0052",
      " line 0053",
      "",
    ].join("\n"),
  );
  // The diff stays a local hunk even for a large baseline file.
  assert.ok(diff.text.length < 400);
  assert.equal((diff.text.match(/^-line /gm) ?? []).length, 1);
});
