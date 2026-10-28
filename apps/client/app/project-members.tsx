/**
 * A project's members as a sheet stacked on the project's (`/project-members?id=`, opened from
 * its ⋯ through src/projects/members-entry.tsx): every member with their role, owners first. A
 * manager adds someone from a menu of the project's assignable people (they join as a member),
 * and a member's row menu changes their role or removes them; everyone else reads the list. The
 * browser shows the same panel as a dialog (src/projects/members-dialog.web.tsx).
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { noAccess, notFound } from '../src/data/access';
import { useT } from '../src/lib/i18n';
import { objectId } from '../src/lib/object-id';
import { MEMBER_ROLES } from '../src/projects/members-model';
import { useProjectMembers } from '../src/projects/use-project-members';
import { makeStyles, space, useTheme } from '../src/theme';
import { Avatar } from '../src/ui/avatar';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { Row, SectionFooter, SectionHeader, rowPosition } from '../src/ui/list';
import { NativeMenu } from '../src/ui/menu';
import { menuSections } from '../src/ui/menu-items';
import { SheetScreen } from '../src/ui/screen';

const AVATAR = 30;

export default function ProjectMembers() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = objectId(raw);
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const m = useProjectMembers(id);
  const gone = id == null || (!m.project && !m.loading && (notFound(m.error) || noAccess(m.error)));

  return (
    <>
      <SheetScreen title={t('projects.members.title')} busy={m.loading && !!m.project} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {gone ? (
          <EmptyState icon="users" title={t('projects.notFound')} style={styles.state} />
        ) : !m.project ? (
          m.loading ? (
            <LoadingState style={styles.state} />
          ) : (
            <EmptyState
              icon="alert"
              title={t('projects.members.loadFailed')}
              onRetry={() => void m.refresh()}
              style={styles.state}
            />
          )
        ) : (
          <>
            {m.manage ? (
              m.candidates.length ? (
                <NativeMenu
                  items={m.candidates.map((user) => ({ id: user.id, title: user.nickname }))}
                  title={t('projects.members.addMember')}
                  onSelect={(userId) => void m.add(userId, 'member')}
                  fill
                >
                  <Row
                    title={t('projects.members.addMember')}
                    icon="userPlus"
                    accessory="chevron"
                    position="only"
                    disabled={m.busy}
                    menuTrigger
                  />
                </NativeMenu>
              ) : (
                <Row title={t('projects.members.nobody')} icon="userPlus" position="only" disabled />
              )
            ) : null}
            <SectionHeader title={t('projects.members.count', { n: m.members.length })} />
            {m.members.map((member, i) => {
              const name = member.nickname ?? member.user_id;
              const can = m.controls(member);
              const row = (
                <Row
                  title={member.user_id === m.me?.id ? t('projects.members.you', { name }) : name}
                  subtitle={t(`projects.members.roles.${member.role}`)}
                  leading={<Avatar name={name} size={AVATAR} />}
                  leadingWidth={AVATAR}
                  accessory={can.role || can.remove ? 'chevron' : 'none'}
                  position={rowPosition(i, m.members.length)}
                  disabled={m.busy && (can.role || can.remove)}
                  menuTrigger={can.role || can.remove}
                />
              );
              if (!can.role && !can.remove) return <React.Fragment key={member.user_id}>{row}</React.Fragment>;
              return (
                <NativeMenu
                  key={member.user_id}
                  title={name}
                  items={menuSections([
                    MEMBER_ROLES.map((role) => ({
                      id: role,
                      title: t(role === 'owner' ? 'projects.members.makeOwner' : 'projects.members.makeMember'),
                      checked: member.role === role,
                    })),
                    can.remove
                      ? [{ id: 'remove', title: t('projects.members.remove'), icon: 'personMinus' as const, destructive: true }]
                      : [],
                  ])}
                  onSelect={(choice) => {
                    if (choice === 'remove') void m.remove(member);
                    else if (choice === 'owner' || choice === 'member') void m.changeRole(member, choice);
                  }}
                  fill
                >
                  {row}
                </NativeMenu>
              );
            })}
            {!m.members.length ? <Row title={t('projects.members.empty')} position="only" disabled /> : null}
            {!m.manage ? <SectionFooter text={t('projects.members.readOnly')} /> : null}
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
