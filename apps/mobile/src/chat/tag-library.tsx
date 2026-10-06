/**
 * TagLibrary — the user's session tags as a SwiftUI Form, in two modes:
 *
 *  - **assign** (`sessionId` given; /sheets/session-tags): a checklist — tap a
 *    tag to attach / detach it from that conversation (✓ = attached). Writes
 *    are optimistic and queued through `useTags().toggleSessionTag`, and the
 *    result lands in `useTags().sessionTags[sessionId]`, which the
 *    conversation renders its chips from. Until the conversation's tags and
 *    ownership are known the list shows a spinner (a failed fetch shows a
 *    retry); the 5-per-conversation limit is explained before anything is
 *    sent. A shared (non-owned) conversation is read-only: it lists that
 *    conversation's tags (the owner's, not ours) as plain rows, no actions.
 *  - **manage** (no `sessionId`; Settings → 标签): tap a tag to edit it.
 *
 * Both writable modes: swipe a row (编辑 / 删除) or touch-and-hold it for the
 * same actions in a system context menu; a 新建标签 row opens the editor sheet
 * (/sheets/tag-editor — which also attaches the new tag in assign mode).
 * Per-user limit: 20 tags. Rows are the shared `FormCheckRow` / `FormNavRow`
 * led by the tag's color dot. Limits and failed writes are system alerts
 * (`alertError`); a rolled-back toggle flips its ✓ back.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Button, ContextMenu, HStack, Image, ProgressView, Section, Spacer, SwipeActions, Text } from '@expo/ui/swift-ui';
import { accessibilityElement, accessibilityHidden, foregroundStyle, lineLimit, tint } from '@expo/ui/swift-ui/modifiers';
import type { SessionTag } from '../shared/greenhouse-types';
import { useTags } from '../store/tags';
import { getSessionTags, MAX_TAGS_PER_SESSION, MAX_TAGS_PER_USER } from '../api/session-tags';
import { tagHex } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { alertError, confirmAction } from '../ui/dialogs';
import { selectionTick } from '../ui/haptics';
import { FormCheckRow, FormNavRow, NativeForm } from '../ui/native-form';

const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

/** What we know about the conversation in assign mode. */
type Access = 'loading' | 'owner' | 'readOnly' | 'failed';

export function TagLibrary({ sessionId }: { sessionId?: string }) {
  const t = useT();
  const router = useRouter();
  const tags = useTags((s) => s.tags);
  const loaded = useTags((s) => s.loaded);
  const loadFailed = useTags((s) => s.failed);
  const load = useTags((s) => s.load);
  const removeTag = useTags((s) => s.remove);
  const toggleSessionTag = useTags((s) => s.toggleSessionTag);
  const assigned = useTags((s) => (sessionId ? s.sessionTags[sessionId] : undefined));
  const [access, setAccess] = useState<Access>(sessionId ? 'loading' : 'owner');
  const [attempt, setAttempt] = useState(0);

  // Always refresh the library (tags may have changed on the web).
  useEffect(() => {
    void load(true);
  }, [load]);

  // Assign mode: learn the conversation's tags + ownership. The conversation
  // screen usually seeded the tags already; the fetch still tells us who owns it.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setAccess('loading');
    void getSessionTags(sessionId).then((r) => {
      if (!alive) return;
      if (!r) {
        setAccess('failed');
        return;
      }
      // never stomp an assignment made (or still being written) since it was seeded
      if (useTags.getState().sessionTags[sessionId] === undefined) useTags.getState().setSessionTags(sessionId, r.tags);
      setAccess(r.isOwner ? 'owner' : 'readOnly');
    });
    return () => {
      alive = false;
    };
  }, [sessionId, attempt]);

  const retry = useCallback(() => {
    void load(true);
    setAttempt((n) => n + 1);
  }, [load]);

  const assignMode = !!sessionId;
  const writable = !assignMode || access === 'owner';
  const canAssign = assignMode && access === 'owner' && assigned !== undefined;

  const edit = (tag: SessionTag) =>
    router.push({ pathname: '/sheets/tag-editor', params: { id: String(tag.id) } });

  const create = () => {
    if (tags.length >= MAX_TAGS_PER_USER) {
      alertError(t('tags.limitPerUser', { n: MAX_TAGS_PER_USER }));
      return;
    }
    if (canAssign && sessionId) {
      // the new tag gets attached right away — explain a full conversation first
      if ((useTags.getState().sessionTags[sessionId]?.length ?? 0) >= MAX_TAGS_PER_SESSION) {
        alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
        return;
      }
      router.push({ pathname: '/sheets/tag-editor', params: { sessionId } });
      return;
    }
    router.push('/sheets/tag-editor');
  };

  const toggle = async (tag: SessionTag) => {
    if (!sessionId || !canAssign) return;
    const current = useTags.getState().sessionTags[sessionId] ?? [];
    const attaching = !current.some((x) => x.id === tag.id);
    if (attaching && current.length >= MAX_TAGS_PER_SESSION) {
      alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
      return;
    }
    selectionTick(); // the ✓ flips now (optimistic); the write follows
    const r = await toggleSessionTag(sessionId, tag);
    if (r === 'limit') alertError(t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
    else if (r === 'failed') alertError(t('tags.assignFailed'));
  };

  const remove = async (tag: SessionTag) => {
    const ok = await confirmAction({
      title: t('tags.deleteTitle'),
      message: t('tags.deleteHint', { name: tag.name }),
      confirmLabel: t('tags.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (!(await removeTag(tag.id))) alertError(t('tags.deleteFailed'));
  };

  const footer =
    access === 'readOnly'
      ? t('tags.readOnly')
      : `${t('tags.hint')}\n${t('tags.manageHint')}`;

  let body: React.ReactNode;
  if (access === 'failed' || (writable && !loaded && loadFailed)) {
    body = (
      <>
        <Text modifiers={[SECONDARY]}>{t('tags.loadFailed')}</Text>
        <Button systemImage="arrow.clockwise" label={t('common.retry')} onPress={retry} />
      </>
    );
  } else if (access === 'loading' || (writable && !loaded) || (assignMode && writable && !canAssign)) {
    body = (
      <HStack>
        <Spacer />
        <ProgressView />
        <Spacer />
      </HStack>
    );
  } else if (access === 'readOnly') {
    // the owner's tags on their conversation — informational only
    body = assigned?.length ? (
      assigned.map((tag) => <TagLabel key={tag.id} tag={tag} />)
    ) : (
      <Text modifiers={[SECONDARY]}>{t('tags.noneOnSession')}</Text>
    );
  } else {
    body = (
      <>
        {tags.length === 0 ? (
          <Text modifiers={[SECONDARY]}>{t('tags.none')}</Text>
        ) : (
          tags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              checked={assignMode ? !!assigned?.some((x) => x.id === tag.id) : undefined}
              onPress={assignMode ? () => void toggle(tag) : () => edit(tag)}
              onEdit={() => edit(tag)}
              onDelete={() => void remove(tag)}
            />
          ))
        )}
        <Button systemImage="plus" label={t('tags.newTag')} onPress={create} />
      </>
    );
  }

  return (
    <NativeForm>
      <Section footer={<Text>{footer}</Text>}>{body}</Section>
    </NativeForm>
  );
}

/** The tag's color dot — data color, decorative for VoiceOver (the name says it all). */
function TagDot({ tag }: { tag: SessionTag }) {
  return <Image systemName="circle.fill" size={12} color={tagHex(tag.color)} modifiers={[accessibilityHidden()]} />;
}

/** Read-only row (a shared conversation's tags): dot + name, no actions. */
function TagLabel({ tag }: { tag: SessionTag }) {
  return (
    <HStack spacing={12} modifiers={[accessibilityElement('combine')]}>
      <TagDot tag={tag} />
      <Text modifiers={[lineLimit(1)]}>{tag.name}</Text>
    </HStack>
  );
}

/**
 * A writable tag row: the color dot leading the shared Form row — a
 * `FormCheckRow` in assign mode (✓ = attached), a `FormNavRow` (chevron → editor)
 * in manage mode. The row's only button makes the whole row the tap target.
 * Swipe / touch-and-hold give 编辑 · 删除.
 */
function TagRow({
  tag,
  checked,
  onPress,
  onEdit,
  onDelete,
}: {
  tag: SessionTag;
  /** Assign mode: attached to the conversation. undefined = manage mode (chevron instead). */
  checked?: boolean;
  onPress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { hex } = useTheme();
  const row = (
    <HStack spacing={12}>
      <TagDot tag={tag} />
      {checked === undefined ? (
        <FormNavRow label={tag.name} onPress={onPress} />
      ) : (
        <FormCheckRow label={tag.name} checked={checked} onPress={onPress} />
      )}
    </HStack>
  );
  return (
    <SwipeActions>
      <ContextMenu>
        <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button systemImage="pencil" label={t('common.edit')} onPress={onEdit} />
          <Button role="destructive" systemImage="trash" label={t('tags.delete')} onPress={onDelete} />
        </ContextMenu.Items>
      </ContextMenu>
      {/* tinted, not role="destructive": that would animate the row away before the confirm alert */}
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        <Button systemImage="trash" label={t('tags.delete')} onPress={onDelete} modifiers={[tint(hex.red)]} />
        <Button systemImage="pencil" label={t('common.edit')} onPress={onEdit} modifiers={[tint(hex.gray)]} />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}
