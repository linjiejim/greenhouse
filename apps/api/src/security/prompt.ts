/**
 * Text that reaches a prompt from people, Agents, pages or tools is data. These helpers keep it
 * from posing as structure: no role headers, no tool-call tags, no hidden characters, and no
 * angle brackets that could close a fence from inside.
 */

const MAX_INPUT_LENGTH = 8000;

export function sanitizeForPrompt(input: string, max = MAX_INPUT_LENGTH): string {
  return input
    .slice(0, max)
    .normalize('NFC')
    .replace(/\n\s*(system|assistant|user)\s*:\s*/gi, '\n')
    .replace(/<\|?(system|assistant|user|im_start|im_end)\|?>/gi, '')
    .replace(/<\/?(tool_call|function_call|function|instructions|tool_result)[^>]*>/gi, '')
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
}

/** For text placed inside a fenced block: nothing in it can open or close a tag. */
export function fence(text: string, max = MAX_INPUT_LENGTH): string {
  return sanitizeForPrompt(text, max).replace(/</g, '‹').replace(/>/g, '›');
}
