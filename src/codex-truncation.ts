/** Port of codex_utils_string::truncate_middle_with_token_budget's byte estimate.
 * The truncation marker is added outside the byte budget, as it is upstream.
 */
export function truncateTextBytes(summary: string, byteBudget: number): string {
  const bytes = Buffer.byteLength(summary, "utf8");
  if (bytes <= byteBudget) return summary;
  const leftBudget = Math.floor(byteBudget / 2);
  const rightStart = bytes - (byteBudget - leftBudget);
  let offset = 0;
  let left = "";
  let right = "";
  for (const character of summary) {
    const end = offset + Buffer.byteLength(character, "utf8");
    if (end <= leftBudget) left += character;
    else if (offset >= rightStart) right += character;
    offset = end;
  }
  return `${left}…${Math.ceil((bytes - byteBudget) / 4)} tokens truncated…${right}`;
}

export function truncateTextTokens(text: string, tokens: number): string {
  return truncateTextBytes(text, tokens * 4);
}
