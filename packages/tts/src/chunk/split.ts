/**
 * 按句界切分朗读文本：不丢字、不改写内容，超长单句硬切。
 *
 * `maxChars` 按 UTF-16 码元计数；硬切时避免把代理对劈成两半。
 */
export function splitSpeechText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars 必须是大于 0 的整数。");
  }
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const units = trimmed.split(/(?<=[。！？!?；;\n])/).filter((unit) => unit !== "");
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };

  for (const unit of units) {
    if (unit.length > maxChars) {
      flush();
      chunks.push(...hardSplit(unit, maxChars));
      continue;
    }
    if (current.length + unit.length > maxChars) flush();
    current += unit;
  }
  flush();
  return chunks;
}

/** 无句界可依时的硬切；不劈开代理对。 */
export function hardSplit(unit: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < unit.length) {
    let end = Math.min(start + maxChars, unit.length);
    const last = unit.charCodeAt(end - 1);
    // 0xD800-0xDBFF 是代理对的前半段：退一位，避免劈开 emoji。
    if (end < unit.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    if (end === start) end = start + 1;
    chunks.push(unit.slice(start, end));
    start = end;
  }
  return chunks;
}
