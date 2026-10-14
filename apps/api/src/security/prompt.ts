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

/**
 * Text from outside Greenhouse in a tool result (a web page, what a connector returns): cut to
 * `max` with a note of how much was left out, and stripped of anything that could pose as prompt
 * structure. The tool's description tells the model it is data.
 */
export function outsideText(text: string, max: number): string {
  const cut = text.length > max ? `${text.slice(0, max)}\n…[cut: ${text.length - max} more characters]` : text;
  return sanitizeForPrompt(cut, max + 100);
}

/** For text placed inside a fenced block: nothing in it can open or close a tag. */
export function fence(text: string, max = MAX_INPUT_LENGTH): string {
  return sanitizeForPrompt(text, max).replace(/</g, '‹').replace(/>/g, '›');
}
