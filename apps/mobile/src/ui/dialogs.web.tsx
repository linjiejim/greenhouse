import React, { useState } from 'react';
import { create } from 'zustand';
import { Overlay } from './overlay.web';
import { recordError } from '../feedback/last-error';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { useTheme } from '../theme';
type Options = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  defaultValue?: string;
  placeholder?: string;
  secure?: boolean;
  detail?: string;
};
let sequence = 0;
type Request = Options & {
  id: number;
  kind: 'confirm' | 'prompt' | 'alert';
  resolve: (v: string | boolean | null) => void;
};
const useDialogs = create<{ queue: Request[] }>(() => ({ queue: [] }));
function ask(kind: Request['kind'], opts: Options) {
  return new Promise<string | boolean | null>((resolve) =>
    useDialogs.setState((s) => ({ queue: [...s.queue, { ...opts, kind, resolve, id: ++sequence }] })),
  );
}
export async function confirmAction(opts: Options): Promise<boolean> {
  return (await ask('confirm', opts)) === true;
}
export async function promptText(opts: Options): Promise<string | null> {
  const v = await ask('prompt', opts);
  return typeof v === 'string' ? v : null;
}
export const confirm = confirmAction;
export const prompt = promptText;
export function alertError(title: string, message?: string, detail?: string) {
  recordError(title, message);
  void ask('alert', { title, message, detail });
}
export function showErrorDetails(detail: string) {
  void ask('alert', { title: translate(usePrefs.getState().lang, 'common.details'), message: detail });
}
export function DialogHost() {
  const current = useDialogs((s) => s.queue[0]);
  return current ? <Dialog key={current.id} request={current} /> : null;
}
function Dialog({ request: r }: { request: Request }) {
  const [value, setValue] = useState(r.defaultValue ?? '');
  const { hex: c } = useTheme();
  const lang = usePrefs((s) => s.lang);
  const [details, setDetails] = useState(false);
  const finish = (v: string | boolean | null) => {
    useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
    r.resolve(v);
  };
  return (
    <Overlay label={r.title} onClose={() => finish(r.kind === 'confirm' ? false : null)}>
      <form
        style={{ width: 360, maxWidth: '100%' }}
        onSubmit={(e) => {
          e.preventDefault();
          finish(r.kind === 'prompt' ? value.trim() || null : true);
        }}
      >
        <h2 style={{ marginTop: 0 }}>{r.title}</h2>
        {r.message ? <p>{r.message}</p> : null}
        {r.kind === 'prompt' ? (
          <input
            aria-label={r.placeholder ?? r.title}
            placeholder={r.placeholder}
            type={r.secure ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: 8, font: 'inherit' }}
          />
        ) : null}
        {r.detail ? (
          <>
            <button type="button" onClick={() => setDetails(!details)}>
              {translate(lang, 'common.details')}
            </button>
            {details ? <pre style={{ whiteSpace: 'pre-wrap' }}>{r.detail}</pre> : null}
          </>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          {r.kind !== 'alert' ? (
            <button type="button" onClick={() => finish(r.kind === 'confirm' ? false : null)}>
              {r.cancelLabel ?? translate(lang, 'common.cancel')}
            </button>
          ) : null}
          <button
            type="submit"
            style={{
              background: r.destructive ? c.red : c.accent,
              color: c.onAccent,
              border: 0,
              borderRadius: 6,
              padding: '8px 16px',
              font: 'inherit',
            }}
          >
            {r.confirmLabel ?? translate(lang, 'common.ok')}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
