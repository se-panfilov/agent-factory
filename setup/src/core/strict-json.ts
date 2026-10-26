/** Bounded callers use this to reject duplicate decoded keys and excessive nesting. */
export function parseStrictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++; };
  function stringToken(): string {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === "\\") offset++;
      else if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw Error("unterminated JSON string");
  }
  function value(depth: number): void {
    if (depth > 128) throw Error("JSON nesting exceeds128");
    whitespace();
    if (text[offset] === "{") {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === "}") { offset++; return; }
      for (;;) {
        whitespace(); const key = stringToken();
        if (keys.has(key)) throw Error("duplicate JSON object key");
        keys.add(key); whitespace(); offset++; // colon, grammar already validated
        value(depth + 1); whitespace();
        if (text[offset++] === "}") return;
      }
    }
    if (text[offset] === "[") {
      offset++; whitespace(); if (text[offset] === "]") { offset++; return; }
      for (;;) { value(depth + 1); whitespace(); if (text[offset++] === "]") return; }
    }
    if (text[offset] === '"') { stringToken(); return; }
    while (offset < text.length && !/[\s,}\]]/.test(text[offset]!)) offset++;
  }
  value(0); whitespace();
  if (offset !== text.length) throw Error("incomplete JSON inventory");
  return parsed;
}
