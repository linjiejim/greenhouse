/** Browser create form for a plugin data entity: only the fields the member may write. */
import React, { useState } from 'react';
import { post } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { localize, type PluginEntitySchema } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { Overlay } from '../ui/overlay.web';
import { writableValues } from './surface-model';

export function EntityCreate({
  entity,
  close,
  created,
}: {
  entity: PluginEntitySchema;
  close: () => void;
  created: (id: string) => void;
}) {
  const t = useT(),
    lang = usePrefs((s) => s.lang);
  const fields = entity.fields.filter((f) => f.writable === true);
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.kind === 'boolean' ? false : ''])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const set = (key: string, value: string | boolean) => setDraft((v) => ({ ...v, [key]: value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let body: Record<string, unknown>;
    try {
      // empty optional inputs stay unset instead of being sent as null
      const filled = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      body = writableValues(entity, filled);
      const missing = fields.find((f) => f.required && !(f.key in body));
      if (missing) throw new Error(missing.key);
    } catch (reason) {
      const key = reason instanceof Error ? reason.message : String(reason);
      const field = fields.find((f) => f.key === key);
      setError(field ? `${localize(field.title, lang)} · ${t('common.error')}` : key);
      return;
    }
    const current = captureIdentity();
    setBusy(true);
    const r = await post<{ id?: string | number }>(entity.endpoint, body);
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      setError(r.message || r.code);
      return;
    }
    close();
    created(String(r.data.id ?? ''));
  };
  return (
    <Overlay label={localize(entity.title, lang)} onClose={close} testID="entity-create">
      <form className="gh-entity-form" onSubmit={(e) => void submit(e)}>
        <h2>
          {t('places.newRecord')} · {localize(entity.title, lang)}
        </h2>
        {fields.map((f) => {
          const label = `${localize(f.title, lang)}${f.required ? ' *' : ''}`;
          const value = draft[f.key];
          return (
            <label key={f.key} className={f.kind === 'boolean' ? 'gh-entity-check' : undefined}>
              {f.kind === 'boolean' ? (
                <input type="checkbox" checked={!!value} onChange={(e) => set(f.key, e.target.checked)} />
              ) : null}
              <span>{label}</span>
              {f.kind === 'boolean' ? null : f.kind === 'enum' ? (
                <select value={String(value)} onChange={(e) => set(f.key, e.target.value)} aria-label={label}>
                  <option value="">—</option>
                  {(f.values ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : f.kind === 'longText' || f.kind === 'json' ? (
                <textarea rows={4} value={String(value)} onChange={(e) => set(f.key, e.target.value)} aria-label={label} />
              ) : (
                <input
                  aria-label={label}
                  value={String(value)}
                  onChange={(e) => set(f.key, e.target.value)}
                  type={
                    ['integer', 'number', 'money'].includes(f.kind)
                      ? 'number'
                      : f.kind === 'date'
                        ? 'date'
                        : f.kind === 'dateTime'
                          ? 'datetime-local'
                          : 'text'
                  }
                />
              )}
            </label>
          );
        })}
        {error ? (
          <p role="alert" className="gh-entity-error">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="gh-primary" disabled={busy}>
            {t('common.save')}
          </button>
        </footer>
      </form>
    </Overlay>
  );
}
