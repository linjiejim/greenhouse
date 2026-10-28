/**
 * Sharing one of my private documents as a sheet stacked on the document's (`/doc-share?id=`,
 * opened from its toolbar through src/knowledge/share-entry.tsx): a menu of members to share it
 * with (they start as readers), then everyone it is shared with; a person's row menu switches
 * between reading and editing or stops sharing. A team document, or one that is not mine, says
 * why there is nothing to share. The browser shows the same panel as a dialog
 * (src/knowledge/share-dialog.web.tsx).
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { noAccess, notFound } from '../src/data/access';
import { useDocShares } from '../src/knowledge/use-doc-shares';
import { SHARE_ROLES } from '../src/knowledge/share-model';
import { useT } from '../src/lib/i18n';
import { objectId } from '../src/lib/object-id';
import { makeStyles, space, useTheme } from '../src/theme';
import { Avatar } from '../src/ui/avatar';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { Row, SectionFooter, SectionHeader, rowPosition } from '../src/ui/list';
import { NativeMenu } from '../src/ui/menu';
import { menuSections } from '../src/ui/menu-items';
import { SheetScreen } from '../src/ui/screen';

const AVATAR = 30;

export default function DocShare() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = objectId(raw);
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const s = useDocShares(id);
  const gone = id == null || (!s.doc && !s.loading && (notFound(s.error) || noAccess(s.error)));

  return (
    <>
      <SheetScreen title={t('knowledge.share.open')} busy={s.loading && !!s.doc} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {gone ? (
          <EmptyState icon="book" title={t('knowledge.notFound')} style={styles.state} />
        ) : !s.doc || (!s.manage && !s.note) ? (
          s.loading ? (
            <LoadingState style={styles.state} />
          ) : (
            <EmptyState
              icon="alert"
              title={t('knowledge.share.loadFailed')}
              onRetry={() => void s.refresh()}
              style={styles.state}
            />
          )
        ) : !s.manage ? (
          <EmptyState icon="users" title={t(`knowledge.share.${s.note ?? 'ownerOnly'}`)} style={styles.state} />
        ) : (
          <>
            {s.noPeople ? (
              <Row title={t('knowledge.share.noPeople')} icon="userPlus" position="only" disabled />
            ) : s.candidates.length ? (
              <NativeMenu
                items={s.candidates.map((user) => ({ id: user.id, title: user.nickname }))}
                title={t('knowledge.share.addPerson')}
                onSelect={(userId) => void s.add(userId, 'reader')}
                fill
              >
                <Row
                  title={t('knowledge.share.addPerson')}
                  icon="userPlus"
                  accessory="chevron"
                  position="only"
                  disabled={s.busy}
                  menuTrigger
                />
              </NativeMenu>
            ) : (
              <Row title={t('knowledge.share.everyone')} icon="userPlus" position="only" disabled />
            )}
            <SectionHeader title={t('knowledge.share.sharedWith')} />
            {s.shares.map((share, i) => (
              <NativeMenu
                key={share.target}
                title={share.name}
                items={menuSections([
                  SHARE_ROLES.map((role) => ({
                    id: role,
                    title: t(`knowledge.share.roles.${role}`),
                    checked: share.role === role,
                  })),
                  [{ id: 'remove', title: t('knowledge.share.remove'), icon: 'personMinus' as const, destructive: true }],
                ])}
                onSelect={(choice) => {
                  if (choice === 'remove') void s.remove(share);
                  else if (choice === 'reader' || choice === 'editor') void s.changeRole(share, choice);
                }}
                fill
              >
                <Row
                  title={share.name}
                  subtitle={t(`knowledge.share.roles.${share.role}`)}
                  leading={<Avatar name={share.name} size={AVATAR} />}
                  leadingWidth={AVATAR}
                  accessory="chevron"
                  position={rowPosition(i, s.shares.length)}
                  disabled={s.busy}
                  menuTrigger
                />
              </NativeMenu>
            ))}
            {!s.shares.length ? <SectionFooter text={t('knowledge.share.nobody')} /> : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
