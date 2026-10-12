/**
 * Publishing (spec §6 发布对话框, D2 / D4 / D5): the draft becomes the next
 * immutable version. Before the owner confirms, the dialog says what that
 * means — the structure that changes against the live version, every
 * permission that moves (before → after), and who gets it: the audience
 * entries, the groups whose managers decide membership, and entries whose
 * role this version drops (they lose access).
 *
 * Only the Base owner or a super publishes; the builder never opens this for
 * anyone else, and the server refuses them (403) regardless. The draft is
 * saved first; a stale revision (409) or remaining problems (400) are shown.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  AppAudienceEntryView,
  AppSpec,
  AppSpecError,
  AppSummary,
  AppVersionSummary,
} from '@greenhouse/types/apps';
import { Button, Dialog, Spinner, Tag, Textarea, toast } from '../../../components/ui';
import { FormActions, FormError, FormField } from '../../../components/form';
import {
  getAppAudiences,
  getPublishedApp,
  isOwnerOnly,
  isRevisionConflict,
  publishApp,
  specErrorsOf,
} from '../../../lib/api/apps-builder';
import { useT } from '../../../lib/i18n';
import { AlertTriangle, Globe, User, Users } from '../../../lib/icons';
import { audienceImpact, diffSpecs, isEmptyDiff, type PermissionChange, type SpecDiff } from './spec-diff';
import { fieldsOf, tableName, type BuilderSchema } from './spec-model';

type Loaded = { live: AppSpec | null; audiences: AppAudienceEntryView[] };

function useChangeText(schema: BuilderSchema, draft: AppSpec, live: AppSpec | null) {
  const t = useT();
  const pageTitle = (id: string) =>
    draft.pages.find((page) => page.id === id)?.title ?? live?.pages.find((page) => page.id === id)?.title ?? id;
  const pagesText = (pages: 'all' | string[]) =>
    pages === 'all'
      ? t('apps.builder.publish.allPages')
      : pages.length === 0
        ? t('apps.builder.publish.noPages')
        : pages.map(pageTitle).join(', ');
  const yesNo = (value: boolean) => (value ? t('common.yes') : t('common.no'));
  const table = (id: number) => tableName(schema, id) ?? `#${id}`;
  const field = (tableId: number, id: number) =>
    fieldsOf(schema, tableId).find((entry) => entry.id === id)?.name ?? `#${id}`;

  return (change: PermissionChange): { subject: string; before?: string; after?: string; note?: string } => {
    switch (change.kind) {
      case 'roleAdded':
        return { subject: t('apps.builder.publish.roleAdded') };
      case 'roleRemoved':
        return { subject: t('apps.builder.publish.roleRemoved') };
      case 'pages':
        return change.before === undefined
          ? { subject: t('apps.builder.publish.pages'), after: pagesText(change.after) }
          : {
              subject: t('apps.builder.publish.pages'),
              before: pagesText(change.before),
              after: pagesText(change.after),
            };
      case 'comment':
        return { subject: t('apps.builder.publish.comment'), before: yesNo(change.before), after: yesNo(change.after) };
      case 'table':
        return {
          subject: table(change.tableId),
          before: t(`tables.access.tableAccess.${change.before}`),
          after: t(`tables.access.tableAccess.${change.after}`),
          ...(change.visibleAfter !== undefined
            ? {
                note: t('apps.builder.publish.fieldCounts', {
                  visible: change.visibleAfter,
                  editable: change.editableAfter ?? 0,
                }),
              }
            : {}),
        };
      case 'rows':
      case 'editRows':
        return {
          subject: t(change.kind === 'rows' ? 'apps.builder.publish.rows' : 'apps.builder.publish.editRows', {
            table: table(change.tableId),
          }),
          before: t(`tables.access.rows.${change.before}`),
          after: t(`tables.access.rows.${change.after}`),
          ...(change.changed ? { note: t('apps.builder.publish.scopeChanged') } : {}),
        };
      case 'create':
      case 'delete':
        return {
          subject: t(change.kind === 'create' ? 'apps.builder.publish.create' : 'apps.builder.publish.delete', {
            table: table(change.tableId),
          }),
          before: yesNo(change.before),
          after: yesNo(change.after),
        };
      case 'field':
        return {
          subject: `${table(change.tableId)} · ${field(change.tableId, change.fieldId)}`,
          before: t(`tables.access.fieldAccess.${change.before}`),
          after: t(`tables.access.fieldAccess.${change.after}`),
        };
    }
  };
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h4>
      {children}
    </section>
  );
}

function StructureList({ diff }: { diff: SpecDiff }) {
  const t = useT();
  const lines: string[] = [];
  for (const page of diff.pagesAdded)
    lines.push(t('apps.builder.publish.pageAdded', { title: page.title, cards: page.cards.length }));
  for (const page of diff.pagesRemoved) lines.push(t('apps.builder.publish.pageRemoved', { title: page.title }));
  for (const change of diff.pagesChanged) {
    const parts = [
      change.renamedFrom !== undefined ? t('apps.builder.publish.renamed', { from: change.renamedFrom }) : null,
      change.cardsAdded.length ? t('apps.builder.publish.cardsAdded', { count: change.cardsAdded.length }) : null,
      change.cardsRemoved.length ? t('apps.builder.publish.cardsRemoved', { count: change.cardsRemoved.length }) : null,
      change.cardsChanged.length ? t('apps.builder.publish.cardsChanged', { count: change.cardsChanged.length }) : null,
      change.settingsChanged ? t('apps.builder.publish.pageSettings') : null,
    ].filter((part): part is string => part !== null);
    lines.push(t('apps.builder.publish.pageChanged', { title: change.page.title, changes: parts.join(' · ') }));
  }
  for (const role of diff.rolesAdded) lines.push(t('apps.builder.publish.roleAddedLine', { name: role.name }));
  for (const role of diff.rolesRemoved) lines.push(t('apps.builder.publish.roleRemovedLine', { name: role.name }));
  for (const role of diff.rolesChanged) lines.push(t('apps.builder.publish.roleChangedLine', { name: role.name }));
  if (diff.appSettingsChanged) lines.push(t('apps.builder.publish.appSettings'));
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-fg-secondary" data-testid="app-publish-structure">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

export function PublishDialog({
  open,
  onClose,
  app,
  spec,
  errors,
  schema,
  flush,
  revision,
  onPublished,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  app: AppSummary;
  spec: AppSpec;
  errors: readonly AppSpecError[];
  schema: BuilderSchema;
  /** Save the draft now; false when it could not be saved. */
  flush: () => Promise<boolean>;
  revision: () => number;
  onPublished: (app: AppSummary, version: AppVersionSummary) => void;
  onConflict: () => void;
}) {
  const t = useT();
  const [notes, setNotes] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState('');
  const [failedErrors, setFailedErrors] = useState<AppSpecError[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const changeText = useChangeText(schema, spec, loaded?.live ?? null);
  // Against the draft as it is now (after the save, the server's normalized copy).
  const diff = useMemo(
    () =>
      loaded ? diffSpecs(loaded.live, spec, (tableId) => fieldsOf(schema, tableId).map((field) => field.id)) : null,
    [loaded, schema, spec],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(null);
    setProblem('');
    setFailedErrors([]);
    setNotes('');
    void (async () => {
      const saved = await flush();
      if (cancelled) return;
      setSaveFailed(!saved);
      try {
        const [published, audiences] = await Promise.all([
          app.publishedVersion !== null ? getPublishedApp(app.id).then((view) => view.spec) : Promise.resolve(null),
          getAppAudiences(app.id).then((view) => view.entries),
        ]);
        if (!cancelled) setLoaded({ live: published, audiences });
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : t('apps.builder.publish.loadFailed'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // The comparison is taken when the dialog opens; edits are not possible while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const impact = useMemo(() => (loaded ? audienceImpact(loaded.audiences, spec) : []), [loaded, spec]);
  const byRole = useMemo(() => {
    const groups = new Map<string, { name: string; changes: PermissionChange[] }>();
    for (const change of diff?.permissions ?? []) {
      const entry = groups.get(change.roleKey) ?? { name: change.roleName, changes: [] };
      entry.changes.push(change);
      groups.set(change.roleKey, entry);
    }
    return [...groups.entries()];
  }, [diff]);

  const nextVersion = (app.publishedVersion ?? 0) + 1;
  const unchanged = diff ? isEmptyDiff(diff) : false;
  const blocked = errors.length > 0 || saveFailed;

  const publish = async () => {
    setPublishing(true);
    setProblem('');
    setFailedErrors([]);
    try {
      const result = await publishApp(app.id, { draftRevision: revision(), notes: notes.trim() || null });
      if (result.pendingReview) {
        toast(t('apps.sandbox.pendingPublish'), 'info');
        onClose();
      } else onPublished(result.app, result.version);
    } catch (error) {
      if (isRevisionConflict(error)) {
        onConflict();
        return;
      }
      const specErrors = specErrorsOf(error);
      if (specErrors) {
        setFailedErrors(specErrors);
        setProblem(t('apps.builder.publish.stillInvalid'));
      } else if (isOwnerOnly(error)) {
        setProblem(t('apps.builder.publish.ownerOnly'));
      } else {
        setProblem(error instanceof Error ? error.message : t('apps.builder.publish.failed'));
      }
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('apps.builder.publish.title', { name: app.name })} size="xl">
      <div className="space-y-5" data-testid="app-publish-dialog">
        {!diff && !problem ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-fg-faint" />
          </div>
        ) : (
          diff &&
          loaded && (
            <>
              <Section title={t('apps.builder.publish.structure')}>
                {diff.first ? (
                  <p className="text-sm text-fg-secondary">
                    {t('apps.builder.publish.first', {
                      pages: spec.pages.length,
                      cards: spec.pages.reduce((sum, page) => sum + page.cards.length, 0),
                      roles: spec.roles.length,
                    })}
                  </p>
                ) : unchanged ? (
                  <p className="text-sm text-fg-muted">
                    {t('apps.builder.publish.noChanges', { version: app.publishedVersion ?? 0 })}
                  </p>
                ) : (
                  <StructureList diff={diff} />
                )}
              </Section>

              <Section title={t('apps.builder.publish.permissions')} testId="app-publish-permissions">
                {byRole.length === 0 ? (
                  <p className="text-sm text-fg-muted">{t('apps.builder.publish.noPermissionChanges')}</p>
                ) : (
                  <div className="space-y-3">
                    {byRole.map(([key, entry]) => (
                      <div key={key} className="rounded-lg border border-edge">
                        <p className="border-b border-edge px-3 py-1.5 text-xs font-semibold text-fg">{entry.name}</p>
                        <ul className="divide-y divide-edge text-xs">
                          {entry.changes.map((change, index) => {
                            const text = changeText(change);
                            return (
                              <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5">
                                <span className="text-fg-secondary">{text.subject}</span>
                                {text.before !== undefined ? (
                                  <span className="text-fg-muted">
                                    {text.before} <span aria-hidden="true">→</span>
                                    <span className="sr-only">{t('apps.builder.publish.becomes')}</span>{' '}
                                    <span className="font-medium text-fg">{text.after}</span>
                                  </span>
                                ) : (
                                  text.after !== undefined && <span className="font-medium text-fg">{text.after}</span>
                                )}
                                {text.note && <span className="text-fg-faint">{text.note}</span>}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title={t('apps.builder.publish.audiences')} testId="app-publish-audiences">
                {impact.length === 0 ? (
                  <p className="text-sm text-fg-muted">{t('apps.builder.publish.noAudience')}</p>
                ) : (
                  <ul className="divide-y divide-edge rounded-lg border border-edge text-sm">
                    {impact.map(({ entry, losesAccess, gainsAccess }, index) => {
                      const Icon =
                        entry.principal.type === 'team' ? Globe : entry.principal.type === 'group' ? Users : User;
                      const role = spec.roles.find((item) => item.key === entry.roleKey)?.name ?? entry.roleKey;
                      return (
                        <li key={index} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <Icon size={13} className="text-fg-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="text-fg">
                              {entry.principal.type === 'team' ? t('apps.builder.audiences.everyone') : entry.name}
                            </span>
                            <span className="text-fg-muted"> · {role}</span>
                            {entry.managedBy && (
                              <span className="block text-[11px] text-fg-faint">
                                {t('apps.builder.audiences.managedBy', { name: entry.managedBy.name })}
                              </span>
                            )}
                          </span>
                          {losesAccess && <Tag tone="danger">{t('apps.builder.publish.losesAccess')}</Tag>}
                          {gainsAccess && <Tag tone="primary">{t('apps.builder.publish.gainsAccess')}</Tag>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>

              <FormField label={t('apps.builder.publish.notes')}>
                <Textarea
                  rows={3}
                  value={notes}
                  maxLength={2000}
                  placeholder={t('apps.builder.publish.notesPlaceholder')}
                  onChange={(event) => setNotes(event.target.value)}
                  data-testid="app-publish-notes"
                />
              </FormField>
            </>
          )
        )}

        {blocked && (
          <p className="flex items-start gap-1.5 text-xs text-danger" role="alert">
            <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
            {saveFailed
              ? t('apps.builder.publish.unsaved')
              : t('apps.builder.publish.hasProblems', { count: errors.length })}
          </p>
        )}
        {failedErrors.length > 0 && (
          <ul className="space-y-0.5 text-xs text-danger">
            {failedErrors.map((error, index) => (
              <li key={index}>{error.message}</li>
            ))}
          </ul>
        )}
        <FormError>{problem}</FormError>
        <FormActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void publish()}
            disabled={!diff || blocked || publishing || (unchanged && !diff.first)}
            data-testid="app-publish-confirm"
          >
            {publishing
              ? t('apps.builder.publish.publishing')
              : t('apps.builder.publish.confirm', { version: nextVersion })}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
