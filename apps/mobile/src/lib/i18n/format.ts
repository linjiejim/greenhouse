export function interpolate(locale: string, template: string, vars: Record<string, string | number>): string {
  return template.replace(
    /( ?)\{(\w+)\}( ?)/g,
    (match, before: string, name: string, after: string, offset: number) => {
      if (vars[name] === undefined) return match;
      const value = String(vars[name]);
      if (locale === 'zh') {
        // Templates space unknown names; Chinese names and relative times stay joined to Chinese copy.
        // Words separating two values (for example, a date range) keep their deliberate spacing.
        const prefix = template.slice(0, offset);
        const suffix = template.slice(offset + match.length);
        if (
          /\p{Script=Han}$/u.test(prefix) &&
          /^\p{Script=Han}/u.test(value) &&
          !/\{\w+\} \p{Script=Han}+$/u.test(prefix)
        )
          before = '';
        if (
          /\p{Script=Han}$/u.test(value) &&
          /^\p{Script=Han}/u.test(suffix) &&
          !/^\p{Script=Han}+ \{\w+\}/u.test(suffix)
        )
          after = '';
      }
      return before + value + after;
    },
  );
}
