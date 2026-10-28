/**
 * Sharing one of my private documents in the browser: a centered `md` dialog (full window below
 * WIDE_MIN) listing who it is shared with and at which access, with a row to share it with
 * someone else. A team document explains that it takes no grants. Data and writes are
 * src/knowledge/use-doc-shares.ts, shared with the phone sheet.
 */
import React, { useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useT } from '../lib/i18n';
import { WIDE_MIN } from '../shell/wide-model';
import { Icon } from '../ui/core';
import { DialogBody, Overlay } from '../ui/overlay.web';
import { SHARE_ROLES, type ShareRole } from './share-model';
import { useDocShares } from './use-doc-shares';

export function DocShareDialog({ docId, close }: { docId: string; close: () => void }) {
  const t = useT();
  const { width } = useWindowDimensions();
  const s = useDocShares(docId);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<ShareRole>('reader');
  const add = async () => {
    if (!pick) return;
    if (await s.add(pick, role)) {
      setPick('');
      setRole('reader');
    }
  };
  const title = s.doc ? t('knowledge.share.title', { title: s.doc.title }) : t('knowledge.share.open');
  return (
    <Overlay
      label={title}
      size="md"
      onClose={close}
      testID="doc-share"
      panelStyle={width < WIDE_MIN ? PHONE_PANEL : undefined}
    >
      <DialogBody
        title={title}
        actions={
          <button type="button" className="gh-icon-button" aria-label={t('common.close')} onClick={close}>
            <Icon name="x" size={18} />
          </button>
        }
        footer={
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.done')}
          </button>
        }
      >
        <div className="gh-form">
          {!s.doc ? (
            s.loading ? (
              <p className="gh-hint">{t('common.loading')}</p>
            ) : (
              <div className="gh-callout" data-tone="danger" role="alert">
                <span className="gh-callout-text">{s.error?.message || t('knowledge.share.loadFailed')}</span>
                <button type="button" className="gh-link-button" onClick={() => void s.refresh()}>
                  {t('common.retry')}
                </button>
              </div>
            )
          ) : !s.manage ? (
            s.note ? (
              <div className="gh-callout" data-tone="info">
                <span className="gh-callout-text">{t(`knowledge.share.${s.note}`)}</span>
              </div>
            ) : s.loading ? (
              <p className="gh-hint">{t('common.loading')}</p>
            ) : (
              <div className="gh-callout" data-tone="danger" role="alert">
                <span className="gh-callout-text">{s.error?.message || t('knowledge.share.loadFailed')}</span>
                <button type="button" className="gh-link-button" onClick={() => void s.refresh()}>
                  {t('common.retry')}
                </button>
              </div>
            )
          ) : (
            <>
              <fieldset className="gh-form-section">
                <legend>{t('knowledge.share.addPerson')}</legend>
                {s.noPeople ? (
                  <p className="gh-hint">{t('knowledge.share.noPeople')}</p>
                ) : s.candidates.length ? (
                  <div
                    className="gh-button-row"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void add();
                      }
                    }}
                  >
                    <select
                      className="gh-input"
                      style={{ flex: 1, minWidth: 160 }}
                      aria-label={t('knowledge.share.person')}
                      value={pick}
                      onChange={(e) => setPick(e.target.value)}
                    >
                      <option value="">{t('knowledge.share.choose')}</option>
                      {s.candidates.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.nickname}
                        </option>
                      ))}
                    </select>
                    <select
                      className="gh-input"
                      style={{ width: 'auto' }}
                      aria-label={t('knowledge.share.role')}
                      value={role}
                      onChange={(e) => setRole(e.target.value as ShareRole)}
                    >
                      {SHARE_ROLES.map((value) => (
                        <option key={value} value={value}>
                          {t(`knowledge.share.roles.${value}`)}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="gh-primary" disabled={!pick || s.busy} onClick={() => void add()}>
                      {t('knowledge.share.add')}
                    </button>
                  </div>
                ) : (
                  <p className="gh-hint">{t('knowledge.share.everyone')}</p>
                )}
              </fieldset>
              <fieldset className="gh-form-section">
                <legend>{t('knowledge.share.sharedWith')}</legend>
                {s.shares.length ? (
                  <table className="gh-data-grid" data-testid="doc-share-list">
                    <thead>
                      <tr>
                        <th>{t('knowledge.share.name')}</th>
                        <th>{t('knowledge.share.role')}</th>
                        <th><span className="gh-sr-only">{t('knowledge.share.remove')}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.shares.map((share) => (
                        <tr key={share.target}>
                          <td style={{ width: '100%' }}>{share.name}</td>
                          <td>
                            <select
                              className="gh-input"
                              aria-label={`${t('knowledge.share.role')} · ${share.name}`}
                              value={share.role}
                              disabled={s.busy}
                              onChange={(e) => void s.changeRole(share, e.target.value as ShareRole)}
                            >
                              {SHARE_ROLES.map((value) => (
                                <option key={value} value={value}>
                                  {t(`knowledge.share.roles.${value}`)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="gh-link-button gh-danger"
                              aria-label={t('knowledge.share.removeLabel', { name: share.name })}
                              disabled={s.busy}
                              onClick={() => void s.remove(share)}
                            >
                              {t('knowledge.share.remove')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="gh-hint">{t('knowledge.share.nobody')}</p>
                )}
              </fieldset>
            </>
          )}
        </div>
      </DialogBody>
    </Overlay>
  );
}

/** Below WIDE_MIN the dialog takes the whole window, as the browser's form dialogs do. */
const PHONE_PANEL: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: 'auto',
  height: 'auto',
  maxWidth: 'none',
  maxHeight: 'none',
  borderRadius: 0,
  border: 0,
};
