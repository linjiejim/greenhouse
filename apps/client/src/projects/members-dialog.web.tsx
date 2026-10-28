/**
 * A project's members in the browser: a centered `md` dialog (full window below WIDE_MIN) with
 * the members and their roles; a manager adds people (from the project's assignable members),
 * changes roles and removes members, everyone else reads the list. Data and writes are
 * src/projects/use-project-members.ts, shared with the phone sheet.
 */
import React, { useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useT } from '../lib/i18n';
import { WIDE_MIN } from '../shell/wide-model';
import { Icon } from '../ui/core';
import { DialogBody, Overlay } from '../ui/overlay.web';
import { MEMBER_ROLES, type MemberRole } from './members-model';
import { useProjectMembers } from './use-project-members';

export function ProjectMembersDialog({ projectId, close }: { projectId: string; close: () => void }) {
  const t = useT();
  const { width } = useWindowDimensions();
  const m = useProjectMembers(projectId);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const add = async () => {
    if (!pick) return;
    if (await m.add(pick, role)) {
      setPick('');
      setRole('member');
    }
  };
  const title = m.project ? `${t('projects.members.title')} · ${m.project.title}` : t('projects.members.title');
  return (
    <Overlay
      label={title}
      size="md"
      onClose={close}
      testID="project-members"
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
          {!m.project ? (
            m.loading ? (
              <p className="gh-hint">{t('common.loading')}</p>
            ) : (
              <div className="gh-callout" data-tone="danger" role="alert">
                <span className="gh-callout-text">{m.error?.message || t('projects.members.loadFailed')}</span>
                <button type="button" className="gh-link-button" onClick={() => void m.refresh()}>
                  {t('common.retry')}
                </button>
              </div>
            )
          ) : (
            <>
              {m.manage ? (
                <fieldset className="gh-form-section">
                  <legend>{t('projects.members.addMember')}</legend>
                  {m.candidates.length ? (
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
                        aria-label={t('projects.members.person')}
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                      >
                        <option value="">{t('projects.members.choose')}</option>
                        {m.candidates.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.nickname}
                          </option>
                        ))}
                      </select>
                      <select
                        className="gh-input"
                        style={{ width: 'auto' }}
                        aria-label={t('projects.members.role')}
                        value={role}
                        onChange={(e) => setRole(e.target.value as MemberRole)}
                      >
                        {MEMBER_ROLES.map((value) => (
                          <option key={value} value={value}>
                            {t(`projects.members.roles.${value}`)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="gh-primary"
                        disabled={!pick || m.busy}
                        onClick={() => void add()}
                      >
                        {t('projects.members.add')}
                      </button>
                    </div>
                  ) : (
                    <p className="gh-hint">{t('projects.members.nobody')}</p>
                  )}
                </fieldset>
              ) : (
                <div className="gh-callout" data-tone="neutral">
                  <span className="gh-callout-text">{t('projects.members.readOnly')}</span>
                </div>
              )}
              <fieldset className="gh-form-section">
                <legend>{t('projects.members.count', { n: m.members.length })}</legend>
                {m.members.length ? (
                  <table className="gh-data-grid" data-testid="project-members-list">
                    <thead>
                      <tr>
                        <th>{t('projects.members.name')}</th>
                        <th>{t('projects.members.role')}</th>
                        {m.manage ? <th><span className="gh-sr-only">{t('projects.members.remove')}</span></th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {m.members.map((member) => {
                        const name = member.nickname ?? member.user_id;
                        const can = m.controls(member);
                        return (
                          <tr key={member.user_id}>
                            <td style={{ width: '100%' }}>
                              {member.user_id === m.me?.id ? t('projects.members.you', { name }) : name}
                            </td>
                            <td>
                              {can.role ? (
                                <select
                                  className="gh-input"
                                  aria-label={`${t('projects.members.role')} · ${name}`}
                                  value={member.role}
                                  disabled={m.busy}
                                  onChange={(e) => void m.changeRole(member, e.target.value as MemberRole)}
                                >
                                  {MEMBER_ROLES.map((value) => (
                                    <option key={value} value={value}>
                                      {t(`projects.members.roles.${value}`)}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                t(`projects.members.roles.${member.role}`)
                              )}
                            </td>
                            {m.manage ? (
                              <td>
                                {can.remove ? (
                                  <button
                                    type="button"
                                    className="gh-link-button gh-danger"
                                    aria-label={t('projects.members.removeLabel', { name })}
                                    disabled={m.busy}
                                    onClick={() => void m.remove(member)}
                                  >
                                    {t('projects.members.remove')}
                                  </button>
                                ) : null}
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="gh-hint">{t('projects.members.empty')}</p>
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
