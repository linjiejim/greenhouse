import { plainText } from '../chat/text';
export const SPEECH_MAX = 4000;
export function speechParts(markdown: string): string[] {
  const text = plainText(
    markdown
      .replace(/^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[ \t]*$|(?![\s\S]))/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^\s*\|.*$/gm, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, ''),
  );
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + SPEECH_MAX);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > at + SPEECH_MAX / 2) end = space;
    }
    parts.push(text.slice(at, end).trim());
    at = end;
  }
  return parts.filter(Boolean);
}
export function insertTranscript(value: string, text: string, selection: { start: number; end: number }): string {
  const start = Math.max(0, Math.min(value.length, selection.start));
  const end = Math.max(start, Math.min(value.length, selection.end));
  return value.slice(0, start) + text + value.slice(end);
}
