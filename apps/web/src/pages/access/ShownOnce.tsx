/**
 * A secret shown exactly once (a personal token, a client secret): read-only fields to copy, a
 * sentence that it will not show again, and 完成. Only a keyed hash stays on the server.
 */

import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { Button, Input, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useNotify } from '../../app/notify';
import { useI18n } from '../../lib/i18n';

export function ShownOnce({
  title,
  fields,
  children,
  onClose,
}: {
  title: string;
  fields: { label: string; value: string }[];
  /** What to do with it and that it shows only now. */
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const copy = (value: string) =>
    void navigator.clipboard
      ?.writeText(value)
      .then(() => notify(t('access.copied')))
      .catch(() => undefined);
  return (
    <Overlay variant="dialog" title={title} onClose={onClose}>
      <div className="app-form">
        {fields.map((field) => (
          <div key={field.label} className="app-stack">
            <span className="app-block-title">{field.label}</span>
            <div className="app-copy-row">
              <Input readOnly value={field.value} aria-label={field.label} onFocus={(event) => event.target.select()} />
              <Button aria-label={t('access.copyField', { name: field.label })} onClick={() => copy(field.value)}>
                <Copy size={icon.sm} />
                {t('access.copy')}
              </Button>
            </div>
          </div>
        ))}
        <p className="app-muted">{children}</p>
      </div>
      <OverlayActions>
        <Button kind="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
