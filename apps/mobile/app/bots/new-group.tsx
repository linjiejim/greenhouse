/**
 * `/bots/new-group` — pick 2–6 of your Bots for a group (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). An RN list (rows carry the
 * plants): each active Bot with its role, the main one first; a tap picks or
 * drops it, the pick order shows as a numbered circle, and the first pick is
 * the lead (主理 badge — it answers and delegates when no one is
 * @-mentioned). The circle grows with Dynamic Type, so the number never
 * spills out of it. Once six are picked the rest are disabled. ✓ creates the
 * group and opens it (named later, from its info sheet). Fewer than two Bots:
 * an empty state that offers to make one. Behaviour:
 * src/bots/manage/use-group-form.ts.
 */

import React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import type { BotView } from '../../src/shared/bots';
import { GROUP_MIN_BOTS, MAX_BOTS_PER_CONVERSATION, pickNumber } from '../../src/bots/manage/group-model';
import { useGroupForm } from '../../src/bots/manage/use-group-form';
import { openThread } from '../../src/bots/nav';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { selectionTick } from '../../src/ui/haptics';
import { Badge, ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

const AVATAR = 30;
/** Empty / failed states sit in the middle of the sheet. */
const CENTERED = { flexGrow: 1, justifyContent: 'center' } as const;

/** Closed Bots (Android, switched off, refused) → home: src/bots/route-gate.tsx. */
export default function NewGroupRoute() {
  return (
    <BotsRouteGate kind="threads">
      <NewGroupSheet />
    </BotsRouteGate>
  );
}

function NewGroupSheet() {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const form = useGroupForm();
  const full = form.selected.length >= MAX_BOTS_PER_CONVERSATION;
  const listing = form.botsLoaded && form.bots.length >= GROUP_MIN_BOTS;

  const create = async () => {
    const created = await form.save();
    if (created) openThread(router, created, 'dismissTo');
  };

  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.groupTitle') }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('check')}
          variant="done"
          tintColor={hex.accent}
          disabled={!form.canSave}
          hidden={!listing}
          accessibilityLabel={t('bots.manage.create')}
          onPress={() => void create()}
        />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[{ paddingTop: space.sm, paddingBottom: space.xxxl }, !listing && CENTERED]}
      >
        {!form.botsLoaded ? (
          form.failed ? (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={form.retry} />
          ) : (
            <LoadingState />
          )
        ) : form.bots.length < GROUP_MIN_BOTS ? (
          <EmptyState
            icon="users"
            title={t('bots.manage.needOneBot')}
            message={t('bots.manage.needOneBotHint')}
            action={
              <NativeButton
                label={t('bots.manage.formNew')}
                icon="plus"
                onPress={() => router.push('/bots/bot-form')}
              />
            }
          />
        ) : (
          <ListSection
            footer={full ? `${t('bots.manage.groupFooter')}\n${t('bots.manage.max6')}` : t('bots.manage.groupFooter')}
          >
            {form.bots.map((bot) => {
              const number = pickNumber(form.selected, bot.id);
              return (
                <PickRow
                  key={bot.id}
                  bot={bot}
                  number={number}
                  lead={bot.id === form.lead}
                  disabled={full && number === null}
                  onPress={() => {
                    selectionTick();
                    form.toggle(bot.id);
                  }}
                />
              );
            })}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}

function PickRow({
  bot,
  number,
  lead,
  disabled,
  onPress,
  last,
}: {
  bot: BotView;
  /** 1-based pick order; null = not picked. */
  number: number | null;
  lead: boolean;
  disabled: boolean;
  onPress: () => void;
  /** Injected by ListSection. */
  last?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { fontScale } = useWindowDimensions();
  const circle = circleSize(fontScale);
  const spoken = [
    bot.name,
    bot.role,
    number !== null ? t('bots.manage.pickedA11y', { n: number }) : null,
    lead ? t('bots.manage.lead') : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <ListRow
      title={bot.name}
      subtitle={bot.role || undefined}
      subtitleLines={1}
      leading={<BotAvatar bot={bot} size={AVATAR} animate={false} />}
      leadingWidth={AVATAR}
      accessory={
        <View style={styles.trailing}>
          {lead ? <Badge label={t('bots.manage.lead')} tone="accent" /> : null}
          {number !== null ? (
            <View style={[styles.circle, circle, styles.picked]}>
              <Text style={styles.number}>{number}</Text>
            </View>
          ) : (
            <View style={[styles.circle, circle, styles.open]} />
          )}
        </View>
      }
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={spoken}
      last={last}
    />
  );
}

/** The pick circle at the default text size: a footnote digit (18-pt line) with room around it. */
const CIRCLE = 24;

/**
 * The circle scales with the digit inside it (footnote follows Dynamic Type —
 * 2.6× at accessibility-extra-large), picked and open alike so a pick never
 * changes the row's size; never smaller than at the default size.
 */
function circleSize(fontScale: number) {
  const size = Math.round(CIRCLE * Math.max(1, fontScale));
  return { width: size, height: size, borderRadius: size / 2 };
}

const useStyles = makeStyles((c) => ({
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  circle: { alignItems: 'center', justifyContent: 'center' },
  picked: { backgroundColor: c.accent },
  open: { borderWidth: 1.5, borderColor: c.tertiaryLabel },
  number: { ...typo.footnote, fontWeight: weight.semibold, color: c.onAccent },
}));
