import type { UserPrompt } from '@greenhouse/types/api';
import { applyTaskVariables } from '@greenhouse/types/tasks';

/**
 * Expand a selected Task only at the send boundary, after the visible draft.
 *
 * Variables are substituted here rather than when the task is picked so the
 * composer keeps showing what the user typed, not a wall of expanded template.
 * Placeholders left unfilled survive into the message on purpose — the profile
 * prompt tells the model to ask about a visible `{{region}}`, whereas blanking
 * it would silently change what the task asks for.
 */
export function composePromptMessage(
  input: string,
  prompt?: UserPrompt | null,
  values: Record<string, string> = {},
): string {
  const body = prompt ? applyTaskVariables(prompt.content, values).trim() : '';
  return [body, input.trim()].filter(Boolean).join('\n\n');
}
