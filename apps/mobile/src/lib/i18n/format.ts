// VENDORED from packages/utils/src/i18n.ts — verbatim below this header.
// Change the canonical helper, re-copy it, and run src/shared/vendor.parity.test.ts.
// apps/mobile cannot import workspace packages (see apps/mobile/AGENTS.md).

/** Spacing at an interpolated value's boundary, without changing the value itself. */
function gap(space: string, left: string, right: string, separator: boolean): string {
  const leftHan = /\p{Script=Han}$/u.test(left);
  const rightHan = /^\p{Script=Han}/u.test(right);
  if (leftHan && rightHan) return separator ? space : '';
  if ((leftHan && /^[\p{Script=Latin}\p{N}]/u.test(right)) || (/[\p{Script=Latin}\p{N}]$/u.test(left) && rightHan))
    return ' ';
  return space;
}

export function interpolate(locale: string, template: string, vars: Record<string, string | number>): string {
  return template.replace(
    /( *)\{(\w+)\}( *)/g,
    (match, before: string, name: string, after: string, offset: number) => {
      if (vars[name] === undefined) return match;
      const value = String(vars[name]);
      if (locale === 'zh') {
        const prefix = template.slice(0, offset);
        const suffix = template.slice(offset + match.length);
        // Keep deliberate separators between two values, such as a date range.
        before = gap(before, prefix, value, /\{\w+\} \p{Script=Han}+$/u.test(prefix));
        after = gap(after, value, suffix, /^\p{Script=Han}+ \{\w+\}/u.test(suffix));
      }
      return before + value + after;
    },
  );
}

/**
 * A template literal for server copy that follows the same spacing rule: two Han runs join
 * without a space, Han next to Latin or digits gets one, anything else keeps the template's.
 * Strings without Han text come out unchanged.
 */
export function han(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) {
    const value = String(values[i]);
    const next = strings[i + 1]!;
    const before = out.match(/ *$/)![0];
    const head = out.slice(0, out.length - before.length);
    const after = next.match(/^ */)![0];
    const tail = next.slice(after.length);
    const separator = i > 0 && /^\p{Script=Han}+$/u.test(strings[i]!.trim()) && strings[i]!.startsWith(' ');
    out = head + gap(before, head, value, separator) + value + gap(after, value, tail, false) + tail;
  }
  return out;
}
