/**
 * Workspace settings form rules (React-free, tested), shared by Runtime config and plugin
 * settings-form sections: only staged keys are sent, a staged `null` clears the stored value so
 * the env var applies again, secrets are write-only (never shown, kept unless retyped or cleared).
 */
import type { WorkspaceSettingView } from './types';

/** Staged edits: a string or boolean to store, null to clear. Untouched keys are absent. */
export type Staged = Record<string, string | boolean | null>;

export const RUNTIME_GROUPS = ['llm', 'media', 'search', 'gateway'] as const;

/** Groups in display order: core runtime groups, then every other group (one per plugin). */
export function settingGroups(
  views: readonly WorkspaceSettingView[],
  keys?: readonly string[],
): { group: string; settings: WorkspaceSettingView[] }[] {
  const map = new Map<string, WorkspaceSettingView[]>();
  if (!keys) for (const group of RUNTIME_GROUPS) map.set(group, []);
  for (const view of views) {
    // Branding and team context have sections of their own.
    if (keys ? !keys.includes(view.key) : view.group === 'branding' || view.group === 'team_context') continue;
    map.set(view.group, [...(map.get(view.group) ?? []), view]);
  }
  return [...map].filter(([, settings]) => settings.length).map(([group, settings]) => ({ group, settings }));
}

/** What a switch shows: a staged value wins, a staged clear shows its fallback, else the effective value. */
export function flagChecked(view: Pick<WorkspaceSettingView, 'flag' | 'value'>, staged: unknown): boolean {
  if (typeof staged === 'boolean') return staged;
  if (staged === null) return view.flag?.fallback ?? false;
  return view.flag?.effective ?? view.value === true;
}

/** Where the value will come from once saved. */
export function shownSource(view: WorkspaceSettingView, staged: Staged[string] | undefined): 'db' | 'env' | 'none' {
  if (staged === null) return view.env ? 'env' : 'none';
  return staged !== undefined ? 'db' : view.source;
}

/** The text field's value: never a secret, a JSON value as text. */
export function fieldText(view: WorkspaceSettingView, staged: Staged[string] | undefined): string {
  if (staged === null) return '';
  if (typeof staged === 'string') return staged;
  if (view.secret || view.value === null || view.value === undefined) return '';
  return typeof view.value === 'string' ? view.value : JSON.stringify(view.value);
}

/** Can this row be cleared (it holds a stored or staged value), or is a clear staged to undo? */
export function clearState(view: WorkspaceSettingView, staged: Staged[string] | undefined): 'clear' | 'undo' | null {
  if (staged === null) return 'undo';
  return view.has_value || staged !== undefined ? 'clear' : null;
}

/** The PUT body: only staged keys, JSON settings parsed (null when a JSON field does not parse). */
export function settingsPayload(
  views: readonly WorkspaceSettingView[],
  staged: Staged,
): { values: Record<string, unknown> } | { invalid: string } {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(staged)) {
    const view = views.find((v) => v.key === key);
    if (!view) continue;
    if (view.type === 'json' && typeof value === 'string') {
      try {
        // an emptied JSON field clears the stored value
        values[key] = value.trim() ? JSON.parse(value) : null;
      } catch {
        return { invalid: view.label || key };
      }
    } else values[key] = value;
  }
  return { values };
}

/** Registry descriptions mark identifiers with backticks: `[text, code, text, …]`. */
export function descriptionParts(text: string): { text: string; code: boolean }[] {
  return text
    .split('`')
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text);
}
