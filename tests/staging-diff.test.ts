import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceDiff } from "../src/pipeline/staging.ts";

/** Builds a document of numbered lines, optionally replacing one line (1-based). */
const numbered = (count: number, edit?: { line: number; text: string }): string => {
  const lines = Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(4, "0")}`);
  if (edit) lines[edit.line - 1] = edit.text;
  return lines.map((line) => `${line}\n`).join("");
};

test("a one-line edit to a large baseline file produces a local hunk, not whole-file replacement", () => {
  const prior = new Map([["MEMORY.md", numbered(100)]]);
  const next = new Map([["MEMORY.md", numbered(100, { line: 50, text: "line 0050 edited" })]]);
  const diff = workspaceDiff(prior, next);
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

/** 0-based unified hunk content, parsed independently of the production emitter. */
interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { kind: " " | "-" | "+"; text: string; marker: boolean }[];
}

/** Parse one unified diff section, asserting valid headers, body prefixes and newline-marker placement. */
function parseSection(path: string, body: string): { path: string; hunks: HunkRange[] } {
  const hunks: HunkRange[] = [];
  let current: HunkRange | null = null;
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = { oldStart: Number(header[1]), oldCount: Number(header[2]), newStart: Number(header[3]), newCount: Number(header[4]), lines: [] };
      continue;
    }
    assert.ok(current, `${path}: hunk body before header`);
    if (line === "\\ No newline at end of file") {
      assert.ok(current.lines.length, `${path}: marker without a preceding line`);
      current.lines[current.lines.length - 1]!.marker = true;
      continue;
    }
    const kind = line[0]!;
    assert.ok(kind === " " || kind === "-" || kind === "+", `${path}: unparseable body line ${JSON.stringify(line)}`);
    current.lines.push({ kind, text: line.slice(1), marker: false });
  }
  if (current) hunks.push(current);
  return { path, hunks };
}

/** Splits a workspace-diff document into ---/+++ pairs. */
function extractSections(text: string): { path: string; hunks: HunkRange[] }[] {
  const lines = text.split("\n");
  const sections: { path: string; hunks: HunkRange[] }[] = [];
  let index = 0;
  while (index < lines.length && !lines[index]!.startsWith("--- ")) index++;
  while (index < lines.length && lines[index]!.startsWith("--- ")) {
    const oldHeader = lines[index++]!;
    assert.ok(lines[index]!.startsWith("+++ "), "missing +++ header");
    const plusHeader = lines[index++]!;
    const path = oldHeader.startsWith("--- /dev/null") ? plusHeader.slice("+++ b/".length) : oldHeader.slice("--- a/".length);
    const body: string[] = [];
    while (index < lines.length && !lines[index]!.startsWith("--- ")) body.push(lines[index++]!);
    sections.push(parseSection(path, body.join("\n")));
  }
  return sections;
}

/** Splits text into lines the same way a unified diff consumer would. */
function lineize(text: string): { text: string; newline: boolean }[] {
  if (text === "") return [];
  const ended = text.endsWith("\n");
  const body = ended ? text.slice(0, -1) : text;
  const raw = ended && body === "" ? [""] : body.split("\n");
  return raw.map((line, index) => ({ text: line, newline: ended || index < raw.length - 1 }));
}

/** Applies parsed hunks to prior content and returns the reconstructed next content. */
function applySections(priorText: string, sections: { path: string; hunks: HunkRange[] }[]): string {
  const oldLines = lineize(priorText);
  const out: { text: string; newline: boolean }[] = [];
  let oldCursor = 0;
  for (const section of sections) {
    for (const hunk of section.hunks) {
      const oldWindowStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
      const oldWindowEnd = oldWindowStart + hunk.oldCount;
      while (oldCursor < oldWindowStart) {
        assert.ok(oldCursor < oldLines.length, "hunk gap runs past the old file");
        out.push(oldLines[oldCursor]!);
        oldCursor++;
      }
      assert.equal(oldCursor, oldWindowStart, "hunk old window start mismatch");
      let oldSeen = 0;
      let newSeen = 0;
      for (const entry of hunk.lines) {
        if (entry.kind === "+") {
          out.push({ text: entry.text, newline: !entry.marker });
          newSeen++;
        } else {
          assert.ok(oldCursor + oldSeen < oldWindowEnd, "hunk old side ran past its declared window");
          assert.equal(oldLines[oldCursor + oldSeen]!.text, entry.text, "hunk old-side line mismatch");
          if (entry.kind === " ") out.push({ text: entry.text, newline: !entry.marker });
          oldSeen++;
          if (entry.kind === " ") newSeen++;
        }
      }
      assert.equal(oldSeen, hunk.oldCount, "old-side count mismatch");
      assert.equal(newSeen, hunk.newCount, "new-side count mismatch");
      oldCursor = oldWindowEnd;
    }
  }
  while (oldCursor < oldLines.length) { out.push(oldLines[oldCursor]!); oldCursor++; }
  return out.map((line) => `${line.text}${line.newline ? "\n" : ""}`).join("");
}

test("empty, CRLF, Unicode, repeated-line and no-final-newline diffs are byte-deterministic across runs", () => {
  const cases: { name: string; prior: Map<string, string>; next: Map<string, string> }[] = [
    { name: "no changes", prior: new Map([["a.md", "x\n"]]), next: new Map([["a.md", "x\n"]]) },
    { name: "added empty file", prior: new Map(), next: new Map([["e.md", ""]]) },
    { name: "deleted empty file", prior: new Map([["e.md", ""]]), next: new Map() },
    { name: "modified to empty", prior: new Map([["e.md", "a\n"]]), next: new Map([["e.md", ""]]) },
    { name: "modified from empty", prior: new Map([["e.md", ""]]), next: new Map([["e.md", "a\n"]]) },
    { name: "crlf versus lf", prior: new Map([["c.md", "l1\nl2\nl3\n"]]), next: new Map([["c.md", "l1\r\nl2\r\nl3\r\n"]]) },
    { name: "unicode lines", prior: new Map([["u.md", "中文\nemoji 🎉\n"], ["gone.md", "孤证\n"]]), next: new Map([["u.md", "中文\nemoji 🎉!\n"]]) },
    { name: "repeated lines", prior: new Map([["r.md", "a\na\na\na\na\n"]]), next: new Map([["r.md", "a\na\nb\na\na\na\n"]]) },
    { name: "degenerate repeated lines", prior: new Map([["r.md", "a\na\na\n"]]), next: new Map([["r.md", "a\nb\na\n"]]) },
    { name: "added file with full text", prior: new Map([["kept.md", "stable\n"]]), next: new Map([["kept.md", "stable\n"], ["new.md", "first\nsecond\n"]]) },
    { name: "deleted file with content", prior: new Map([["kept.md", "stable\n"], ["gone.md", "first\nsecond\n"]]), next: new Map([["kept.md", "stable\n"]]) },
    { name: "newline added", prior: new Map([["n.md", "without newline"]]), next: new Map([["n.md", "without newline\n"]]) },
    { name: "newline removed", prior: new Map([["n.md", "with\nnewline\n"]]), next: new Map([["n.md", "with\nnewline"]]) },
    { name: "both sides lack a final newline", prior: new Map([["n.md", "x\ny"]]), next: new Map([["n.md", "x\nz"]]) },
  ];
  for (const { name, prior, next } of cases) {
    const first = workspaceDiff(prior, next);
    const second = workspaceDiff(prior, next);
    assert.equal(first.text, second.text, `${name}: output differs between runs`);
    assert.equal(first.fallback, second.fallback, `${name}: fallback flag differs between runs`);
    assert.equal(first.reason, second.reason, `${name}: reason differs between runs`);
    assert.equal(first.fallback, false, `${name}: unexpected fallback`);
    // The complete changed-path index is always present and explicit.
    const expectedIndex = [...new Set([...prior.keys(), ...next.keys()])].sort()
      .filter((path) => prior.get(path) !== next.get(path))
      .map((path) => `- ${prior.has(path) ? next.has(path) ? "modified" : "deleted" : "added"}: ${path}`);
    const index = first.text.split("\n").filter((line) => /^- (added|deleted|modified): /.test(line));
    assert.deepEqual(index, expectedIndex, `${name}: changed-path index mismatch`);
    // Round-trip: applying the emitted hunks to the prior content reconstructs the next content.
    const sections = extractSections(first.text);
    for (const path of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
      if (prior.get(path) === next.get(path)) continue;
      const reconstructed = applySections(prior.get(path) ?? "", sections.filter((section) => section.path === path));
      assert.equal(reconstructed, next.get(path) ?? "", `${name} (${path}): round-trip reconstruction mismatch`);
    }
  }
});

test("pathological edits fall back to the complete path index with computation_limit, never a partial diff", () => {
  // Every other line differs, so the shortest edit script exceeds the bounded
  // edit-distance cap and no section may be emitted.
  const pathological = (prefix: string): string => {
    const lines = [];
    for (let i = 0; i < 30_000; i++) lines.push(i % 2 === 0 ? `u${prefix}${i}` : "common");
    return `${lines.map((line) => `${line}
`).join("")}tail-${prefix}
`;
  };
  const prior = new Map([["huge.md", pathological("old")], ["small.txt", "tiny\n"]]);
  const next = new Map([["huge.md", pathological("new")], ["small.txt", "touched\n"]]);
  const first = workspaceDiff(prior, next);
  const second = workspaceDiff(prior, next);
  assert.equal(first.text, second.text, "fallback text differs between runs");
  assert.deepEqual(first, { text: first.text, fallback: true, reason: "computation_limit" });
  assert.ok(!first.text.includes("--- a/huge.md"), "partial diff emitted for a pathological file");
  assert.ok(!first.text.includes("+u"), "pathological plaintext leaked into the fallback");
  assert.equal(
    first.text.split("\n").filter((line) => /^- (added|deleted|modified): /.test(line)).join("\n"),
    "- modified: huge.md\n- modified: small.txt",
  );
  assert.ok(first.text.length < 4096, "fallback index is not bounded");
});

test("a diff crossing the 4 MiB ceiling mid-manifest yields the complete index with the size reason", () => {
  const line = `${"x".repeat(64 * 1024)}\n`;
  const prior = new Map<string, string>();
  const next = new Map(["big-a.md", "big-b.md"].reduce((acc, path, index) => { acc.set(path, line.repeat(30 + index * 12)); return acc; }, new Map<string, string>()));
  const diff = workspaceDiff(prior, next);
  assert.deepEqual(diff, { text: diff.text, fallback: true, reason: "size" });
  assert.equal(
    diff.text.split("\n").filter((l) => /^- (added|deleted|modified): /.test(l)).join("\n"),
    "- added: big-a.md\n- added: big-b.md",
  );
  assert.ok(!diff.text.includes("+++ "), "partial diff emitted past the ceiling");
  assert.ok(Buffer.byteLength(diff.text) < 4096);
});

test("the complete rendered diff includes heading, index and UTF-8 bytes in its 4 MiB ceiling", () => {
  const path = "rollout_summaries/source.md";
  // This single added unterminated line has 153 bytes of heading/index/hunk framing.
  const fits = workspaceDiff(new Map(), new Map([[path, "x".repeat(4_194_151)]]));
  assert.equal(Buffer.byteLength(fits.text), 4_194_304);
  assert.equal(fits.fallback, false, "exactly at the ceiling is allowed");
  for (const body of ["x".repeat(4_194_200), "x".repeat(4_194_151) + "x",
    "x".repeat(4_194_150) + "界"]) {
    const diff = workspaceDiff(new Map(), new Map([[path, body]]));
    assert.equal(diff.fallback, true);
    assert.equal(diff.reason, "size");
    assert.match(diff.text, /Complete changed-path index:/);
    assert.match(diff.text, /- added: rollout_summaries\/source\.md/);
    assert.doesNotMatch(diff.text, /\+\+\+|xxx|界/);
  }
  // Additional index entries and section separators also belong to the full bound.
  const many = workspaceDiff(new Map([["gone.md", ""]]),
    new Map([[path, "x".repeat(4_194_151)], ["empty.md", ""]]));
  assert.equal(many.reason, "size");
  assert.deepEqual(many.text.split("\n").filter(line => /^- (added|deleted): /.test(line)),
    ["- added: empty.md", "- deleted: gone.md", `- added: ${path}`]);
});

test("randomized line edits round-trip through the unified diff and stay deterministic", () => {
  // Deterministic xorshift PRNG: the test vetoes machine- or run-dependent output.
  let state = 0x2f6e2b1;
  const random = (limit: number): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % limit;
  };
  const words = ["a", "a", "a", "b", "b", "", "c a", " ", "中文", "🎉", "x\r", "---", "+", "@@", "\\ No newline at end of file"];
  for (let iteration = 0; iteration < 120; iteration++) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let line = 0, end = random(30); line < end; line++) oldLines.push(words[random(words.length)]!);
    for (let line = 0, end = random(30); line < end; line++) newLines.push(words[random(words.length)]!);
    const finish = (lines: string[], finalNewline: boolean): string =>
      lines.map((line, index) => `${line}${finalNewline || index < lines.length - 1 ? "\n" : ""}`).join("");
    const oldText = finish(oldLines, random(2) === 0);
    const newText = finish(newLines, random(2) === 0);
    if (oldText === newText) continue;
    const prior = new Map([["file.md", oldText]]);
    const next = new Map([["file.md", newText]]);
    const first = workspaceDiff(prior, next);
    const second = workspaceDiff(prior, next);
    assert.equal(first.text, second.text, `iteration ${iteration}: non-deterministic output`);
    assert.equal(first.fallback, false, `iteration ${iteration}: unexpected fallback`);
    const sections = extractSections(first.text).filter((section) => section.path === "file.md");
    assert.equal(applySections(oldText, sections), newText, `iteration ${iteration}: round-trip mismatch`);
  }
});