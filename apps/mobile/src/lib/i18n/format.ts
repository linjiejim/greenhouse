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
