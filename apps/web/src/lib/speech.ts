/**
 * What read-aloud says (conversation.md, 消息操作): the prose of a reply, without Markdown's
 * marks, code blocks, tables, pictures or Rich Output blocks; and that prose cut into parts a
 * voice can take at once, at the ends of sentences.
 */

import { Lexer, type Token } from 'marked';
import { parseSegments } from '@greenhouse/types/rich-output';

const SKIPPED = new Set(['code', 'table', 'hr', 'html', 'space', 'def', 'image', 'checkbox']);

/** The words of some Markdown tokens: marks dropped, links read by their text. */
function words(tokens: readonly Token[] | undefined): string {
  let out = '';
  for (const token of tokens ?? []) {
    if (SKIPPED.has(token.type)) continue;
    if (token.type === 'br') out += '\n';
    else if (token.type === 'codespan' || token.type === 'escape') out += (token as { text: string }).text;
    else if ('tokens' in token && token.tokens) out += words(token.tokens);
    else if (token.type === 'list') out += (token.items as Token[]).map((item) => words([item])).join('\n');
    else if ('text' in token && typeof token.text === 'string') out += token.text;
  }
  return out;
}

/** The blocks of some Markdown as lines of plain text. */
function blocks(tokens: readonly Token[]): string[] {
  const lines: string[] = [];
  for (const token of tokens) {
    if (SKIPPED.has(token.type)) continue;
    if (token.type === 'list') {
      for (const item of token.items as { tokens: Token[] }[]) lines.push(...blocks(item.tokens));
    } else if (token.type === 'blockquote') {
      lines.push(...blocks((token as { tokens: Token[] }).tokens));
    } else {
      lines.push(words([token]));
    }
  }
  return lines.map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

/** A reply's prose as plain text to read aloud: no Markdown, code, tables, pictures or blocks. */
export function speechText(markdown: string): string {
  const prose = parseSegments(markdown)
    .filter((segment) => segment.type === 'markdown')
    .map((segment) => (segment as { content: string }).content)
    .join('\n\n');
  return blocks(new Lexer({ gfm: true }).lex(prose)).join('\n');
}

/** Ends of sentences, Chinese and Western, and of lines. */
const SENTENCE = /(?<=[。！？!?；;…\n]|\.(?=\s))\s*/u;

/**
 * Parts of at most `max` characters, cut after a sentence where one ends in time, so a voice
 * can say each in one go; a sentence longer than that is cut where it must.
 */
export function speechChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of text.split(SENTENCE)) {
    if (!sentence) continue;
    if ([...current].length + [...sentence].length + 1 > max) flush();
    let rest = sentence;
    while ([...rest].length > max) {
      const characters = [...rest];
      chunks.push(characters.slice(0, max).join('').trim());
      rest = characters.slice(max).join('');
    }
    current = current ? `${current} ${rest}` : rest;
  }
  flush();
  return chunks;
}
