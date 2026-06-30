/**
 * Ambient declaration for `marked-terminal`.
 *
 * The package ships no `.d.ts` and there is no `@types/marked-terminal`, so the
 * implicit-any imports fail under `strict`. We use only the
 * `markedTerminal(options)` factory (whose result is cast to a marked extension at
 * the call site), so a minimal surface suffices.
 */
declare module 'marked-terminal' {
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): unknown;
}
