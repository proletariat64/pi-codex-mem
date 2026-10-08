/**
 * Deterministic bounded line-level unified diffs (spec §6, ticket #56).
 *
 * Replaces whole-file delete/add hunks for modified files with local
 * unified hunks computed by a bounded Myers shortest-edit-script search.
 * The algorithm is self-contained and runs without a Git repository,
 * shell access or runtime dependencies. It is deterministic for every
 * input: Myers breaks ties by fixed diagonal order and all emitted text
 * is derived from stable line keys.
 *
 * Bounded means bounded: the per-file edit-distance cap and shared work
 * budget never yield a partial diff. When either bound is exceeded the
 * caller must fall back to the complete changed-path index and record
 * `computation_limit`; the 4 MiB output ceiling yields `size`.
 */
export const DIFF_POLICY_VERSION = 2;

/** Context lines shown around every changed region. */
const CONTEXT_LINES = 3;
/** Maximum edit distance explored per file before the path-index fallback. */
const MAX_EDIT_DISTANCE = 2048;
/** Per-file work budget (diagonal and snake steps) before the path-index fallback. */
const MAX_FILE_WORK = 20_000_000;
/** Shared work budget for one complete workspace diff. */
export const DIFF_TOTAL_WORK = MAX_FILE_WORK * 2;

export type DiffOverrun = "computation_limit";

/** Mutable shared work budget across every file of one diff run. */
export interface WorkBudget {
  left: number;
}

interface FileLine {
  /** Line text without its terminator. */
  text: string;
  /** Whether the line is terminated with "\n" (only the final line may not be). */
  newline: boolean;
}

/** Line identity includes the final-newline status so `x` differs from `x\n`. */
const keyOf = (line: FileLine): string => line.newline ? `${line.text}\n` : line.text;

function splitLines(text: string): FileLine[] {
  if (text === "") return [];
  const ended = text.endsWith("\n");
  const body = ended ? text.slice(0, -1) : text;
  const raw = ended && body === "" ? [""] : body.split("\n");
  const lines = raw.map((part) => ({ text: part, newline: true }));
  if (!ended) lines[lines.length - 1] = { ...lines[lines.length - 1]!, newline: false };
  return lines;
}

/** One edit-script operation; runs compress consecutive lines of one kind. */
interface Op {
  /** 0 = same run, 1 = deletion run, 2 = insertion run. */
  t: 0 | 1 | 2;
  /** First old line index (same/deletion), -1 for insertions. */
  x: number;
  /** First new line index (same/insertion), -1 for deletions. */
  y: number;
  /** Lines in the run (>= 1). */
  n: number;
}

interface MyersStep {
  t: 0 | 1 | 2;
  i: number;
  j: number;
}

/** Bounded greedy Myers search with a trace-limited backtrack window. */
function myersScript(a: readonly string[], b: readonly string[], budget: WorkBudget): { script: MyersStep[] | null; overrun: boolean } {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(MAX_EDIT_DISTANCE, n + m);
  if (maxD === 0) return { script: [], overrun: false };
  const workLimit = Math.min(budget.left, MAX_FILE_WORK);
  if (workLimit <= 0) { budget.left = 0; return { script: null, overrun: true }; }
  const offset = MAX_EDIT_DISTANCE;
  // k ranges over [-MAX_EDIT_DISTANCE, MAX_EDIT_DISTANCE] within the cap.
  const v = new Int32Array(2 * MAX_EDIT_DISTANCE + 1).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      work++;
      // Slot reads are always within [-d, d] of earlier rounds; alignment with
      // the fill value (-1) keeps comparisons deterministic.
      const right = v[offset + k + 1] ?? -1;
      const left = v[offset + k - 1] ?? -1;
      let x: number;
      if (k === -d || (k !== d && left < right)) x = right;
      else x = left + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; work++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
      if (work > workLimit) break;
    }
    if (found >= 0) break;
    if (work > workLimit) { budget.left = 0; return { script: null, overrun: true }; }
  }
  budget.left = Math.max(0, budget.left - work);
  if (found < 0) return { script: null, overrun: true };
  const script: MyersStep[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 1; d--) {
    const round = trace[d]!;
    const k = x - y;
    const roundRight = round[k + d + 1] ?? -1;
    const roundLeft = round[k + d - 1] ?? -1;
    let prevK: number;
    if (k === -d || (k !== d && roundLeft < roundRight)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = round[prevK + d] ?? -1;
    const prevY = prevX - prevK;
    const snakeX = prevK === k + 1 ? prevX : prevX + 1;
    const snakeY = prevK === k + 1 ? prevY + 1 : prevY;
    while (x > snakeX && y > snakeY) { script.push({ t: 0, i: x - 1, j: y - 1 }); x--; y--; }
    if (x !== snakeX || y !== snakeY) return { script: null, overrun: true };
    if (prevK === k + 1) { script.push({ t: 2, i: -1, j: y - 1 }); y--; }
    else { script.push({ t: 1, i: x - 1, j: -1 }); x--; }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) { script.push({ t: 0, i: x - 1, j: y - 1 }); x--; y--; }
  while (x > 0) { script.push({ t: 1, i: x - 1, j: -1 }); x--; }
  while (y > 0) { script.push({ t: 2, i: -1, j: y - 1 }); y--; }
  script.reverse();
  return { script, overrun: false };
}

/** Whole-file edit script with trimmed common prefixes and suffixes. */
function buildOps(oldLines: readonly FileLine[], newLines: readonly FileLine[], budget: WorkBudget): { ops: Op[] | null; overrun: boolean } {
  const oldKeys = oldLines.map(keyOf);
  const newKeys = newLines.map(keyOf);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldKeys[start] === newKeys[start]) start++;
  while (oldEnd > start && newEnd > start && oldKeys[oldEnd - 1] === newKeys[newEnd - 1]) { oldEnd--; newEnd--; }
  if (oldEnd === start && newEnd === start) return { ops: [], overrun: false };
  const flat: Op[] = [];
  if (start > 0) flat.push({ t: 0, x: 0, y: 0, n: start });
  const n = oldEnd - start;
  const m = newEnd - start;
  if (n === 0) flat.push({ t: 2, x: -1, y: start, n: m });
  else if (m === 0) flat.push({ t: 1, x: start, y: -1, n });
  else {
    const middle = myersScript(oldKeys.slice(start, oldEnd), newKeys.slice(start, newEnd), budget);
    if (middle.overrun || !middle.script) return { ops: null, overrun: true };
    for (const step of middle.script) {
      if (step.t === 0) flat.push({ t: 0, x: start + step.i, y: start + step.j, n: 1 });
      else if (step.t === 1) flat.push({ t: 1, x: start + step.i, y: -1, n: 1 });
      else flat.push({ t: 2, x: -1, y: start + step.j, n: 1 });
    }
  }
  if (oldEnd < oldLines.length) flat.push({ t: 0, x: oldEnd, y: newEnd, n: oldLines.length - oldEnd });
  // Compress every consecutive run so large files stay O(changed lines).
  const ops: Op[] = [];
  for (const op of flat) {
    const last = ops[ops.length - 1];
    if (last && last.t === op.t && last.n > 0 &&
      (op.t === 0 || (op.t === 1 && last.x + last.n === op.x) || (op.t === 2 && last.y + last.n === op.y))) {
      last.n += op.n;
    } else ops.push(op);
  }
  return { ops, overrun: false };
}

/** A maximal run of consecutive deletions/insertions, closed by a same run. */
interface Group {
  firstOp: number;
  endOp: number;
  hasDel: boolean;
  hasIns: boolean;
  oldFirst: number;
  oldLast: number;
  newFirst: number;
  newLast: number;
  anchorOld: number;
  anchorNew: number;
}

function splitGroups(ops: readonly Op[]): Group[] {
  const raw: Group[] = [];
  let x = 0;
  let y = 0;
  let open: Group | null = null;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    if (op.t === 0) {
      if (open) { open.endOp = index; raw.push(open); open = null; }
      x += op.n;
      y += op.n;
    } else {
      if (!open) open = { firstOp: index, endOp: ops.length, hasDel: false, hasIns: false, oldFirst: 0, oldLast: 0, newFirst: 0, newLast: 0, anchorOld: x, anchorNew: y };
      if (op.t === 1) {
        if (!open.hasDel) { open.hasDel = true; open.oldFirst = op.x; }
        open.oldLast = op.x + op.n - 1;
      } else {
        if (!open.hasIns) { open.hasIns = true; open.newFirst = op.y; }
        open.newLast = op.y + op.n - 1;
      }
      x += op.t === 1 ? op.n : 0;
      y += op.t === 2 ? op.n : 0;
    }
  }
  if (open) { open.endOp = ops.length; raw.push(open); }
  // Groups separated by at most 2*CONTEXT_LINES unchanged lines share hunk context.
  const groups: Group[] = [];
  for (const group of raw) {
    const last = groups[groups.length - 1];
    const separator = last ? ops[last.endOp] : undefined;
    if (last && separator && separator.t === 0 && separator.n <= 2 * CONTEXT_LINES) {
      last.endOp = group.endOp;
      if (group.hasDel) {
        if (last.hasDel) last.oldLast = group.oldLast;
        else { last.hasDel = true; last.oldFirst = group.oldFirst; last.oldLast = group.oldLast; }
      }
      if (group.hasIns) {
        if (last.hasIns) last.newLast = group.newLast;
        else { last.hasIns = true; last.newFirst = group.newFirst; last.newLast = group.newLast; }
      }
    } else groups.push(group);
  }
  return groups;
}

function renderHunks(ops: readonly Op[], oldLines: readonly FileLine[], newLines: readonly FileLine[]): string[] {
  const hunks: string[] = [];
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  for (const group of splitGroups(ops)) {
    // Consume up to CONTEXT_LINES leading context lines from the same run
    // directly before the group; a larger run contributes only its last lines.
    let start = group.firstOp;
    let lead = CONTEXT_LINES;
    while (lead > 0 && start > 0) {
      const previous = ops[start - 1]!;
      if (previous.t !== 0 || previous.n > lead) break;
      start--;
      lead -= previous.n;
    }
    const leadOp = lead > 0 && start > 0 && ops[start - 1]!.t === 0 ? start - 1 : -1;
    const leadLines = leadOp >= 0 ? lead : 0;
    let end = group.endOp;
    let tail = CONTEXT_LINES;
    while (tail > 0 && end < ops.length) {
      const next = ops[end]!;
      if (next.t !== 0 || next.n > tail) break;
      end++;
      tail -= next.n;
    }
    const tailOp = tail > 0 && end < ops.length && ops[end]!.t === 0 ? end : -1;
    const tailLines = tailOp >= 0 ? tail : 0;
    // One entry per emitted body line; counts and header starts come from real
    // emitted lines so the header can never disagree with the body.
    const entries: { kind: " " | "-" | "+"; text: string; x: number; y: number; marker: boolean }[] = [];
    const markers: number[] = [];
    const emitSame = (x: number, y: number): void => {
      const line = oldLines[x]!;
      entries.push({ kind: " ", text: line.text, x, y, marker: false });
      if (x === oldLen - 1 && !line.newline) markers.push(entries.length);
    };
    if (leadOp >= 0) {
      const op = ops[leadOp]!;
      for (let j = op.n - leadLines; j < op.n; j++) emitSame(op.x + j, op.y + j);
    }
    for (let index = start; index < end; index++) {
      const op = ops[index]!;
      if (op.t === 0) {
        for (let j = 0; j < op.n; j++) emitSame(op.x + j, op.y + j);
      } else if (op.t === 1) {
        for (let j = 0; j < op.n; j++) {
          const x = op.x + j;
          const line = oldLines[x]!;
          entries.push({ kind: "-", text: line.text, x, y: -1, marker: false });
          if (x === oldLen - 1 && !line.newline) markers.push(entries.length);
        }
      } else {
        for (let j = 0; j < op.n; j++) {
          const y = op.y + j;
          const line = newLines[y]!;
          entries.push({ kind: "+", text: line.text, x: -1, y, marker: false });
          if (y === newLen - 1 && !line.newline) markers.push(entries.length);
        }
      }
    }
    if (tailOp >= 0) {
      const op = ops[tailOp]!;
      for (let j = 0; j < tailLines; j++) emitSame(op.x + j, op.y + j);
    }
    if (!entries.length) continue;
    const oldSide = entries.filter((entry) => entry.kind !== "+");
    const newSide = entries.filter((entry) => entry.kind !== "-");
    const oldText = oldSide.length ? oldSide[0]!.x + 1 : group.anchorOld;
    const newText = newSide.length ? newSide[0]!.y + 1 : group.anchorNew;
    const lines: string[] = [`@@ -${oldText},${oldSide.length} +${newText},${newSide.length} @@`];
    let markerCursor = 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      lines.push(`${entry.kind}${entry.text}`);
      if (markerCursor < markers.length && markers[markerCursor] === index + 1) {
        lines.push("\\ No newline at end of file");
        markerCursor++;
      }
    }
    hunks.push(`${lines.join("\n")}\n`);
  }
  return hunks;
}

export interface FileDiffOutcome {
  /** Joined unified hunks for one file, or null when nothing changed. */
  hunks: string | null;
  overrun: DiffOverrun | null;
}

/** Deterministic bounded unified hunks for one file (not including ---/+++ headers). */
export function diffFileHunks(oldText: string, newText: string, budget: WorkBudget): FileDiffOutcome {
  if (oldText === newText) return { hunks: null, overrun: null };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const built = buildOps(oldLines, newLines, budget);
  if (built.overrun) return { hunks: null, overrun: "computation_limit" };
  const hunks = renderHunks(built.ops ?? [], oldLines, newLines);
  return { hunks: hunks.length ? hunks.join("") : null, overrun: null };
}