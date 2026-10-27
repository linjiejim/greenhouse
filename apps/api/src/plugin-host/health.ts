import { toErrorMessage } from '@greenhouse/utils/error';
/** Process-local boot facts. CLI status reports not-run; it never runs hooks as a read side effect. */
const facts = new Map<string, { state: 'ready' | 'error'; errors: string[] }>();
export function extensionBootFact(id: string) {
  return facts.get(id) ?? { state: 'not-run' as const, errors: [] };
}
export function recordExtensionBootReady(id: string): void {
  facts.set(id, { state: 'ready', errors: [] });
}
export function recordExtensionBootError(id: string, error: unknown): void {
  facts.set(id, { state: 'error', errors: [toErrorMessage(error)] });
}
