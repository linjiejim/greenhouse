import type { Locator } from '@playwright/test';

/**
 * Choose in a Select (apps/client/src/ui/select.web.tsx), the browser's one dropdown: open it, then
 * press the option by its value, or by its visible label.
 */
export async function choose(select: Locator, option: string | { label: string }) {
  await select.click();
  const list = select.page().getByRole('listbox');
  await (
    typeof option === 'string'
      ? list.locator(`[role="option"][data-value="${option}"]`)
      : list.getByRole('option', { name: option.label, exact: true })
  ).click();
}
