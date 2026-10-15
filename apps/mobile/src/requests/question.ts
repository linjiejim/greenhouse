import type { NeedsYou, QuestionField } from '../shared/contract';

/** Only a small single-choice ask can be settled with one tap in the transcript. */
export function inlineQuestion(request: Pick<NeedsYou, 'kind' | 'subject' | 'payload'>): QuestionField | null {
  const fields = request.payload.fields;
  if (request.kind !== 'question' || request.subject !== 'ask_user' || !Array.isArray(fields) || fields.length !== 1)
    return null;
  const field = fields[0] as QuestionField | undefined;
  return field?.type === 'choice' &&
    typeof field.key === 'string' &&
    Array.isArray(field.options) &&
    field.options.length > 0 &&
    field.options.length <= 6 &&
    field.options.every((option) => typeof option === 'string' && option.length > 0)
    ? field
    : null;
}
