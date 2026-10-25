/**
 * One change in the bell's team activity: the object, who changed it (and through which agent),
 * when. Tapping opens the object (or the run) the shared way; rules in ./activity.ts.
 */

import React from 'react';
import type { ActivityItem } from '../shared/greenhouse-types';
import { useT, type TranslationKey } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { useOpenHref, useOpenObject } from '../shell/open-object';
import type { IconName } from '../ui/core';
import { Row, rowPosition } from '../ui/list';
import { activityLine, activityOpening, activityTitle } from './activity';

const SOURCE_ICON: Record<ActivityItem['source'], IconName> = {
  person: 'person',
  agent: 'sparkle',
  automation: 'clock',
  admin: 'shieldCheck',
};

export function ActivityRow({ item, index, count }: { item: ActivityItem; index: number; count: number }) {
  const t = useT();
  const openObject = useOpenObject();
  const openHref = useOpenHref();
  const opening = activityOpening(item);
  const title = activityTitle(item);
  const line = activityLine(item, {
    someone: t('notifications.someone'),
    verb: (verb) => {
      const key = `notifications.verb.${verb}`;
      const value = t(key as TranslationKey);
      return value === key ? null : value;
    },
  });
  return (
    <Row
      title={title}
      titleLines={2}
      subtitle={line}
      icon={SOURCE_ICON[item.source] ?? 'person'}
      value={relativeTimeNow(item.at)}
      accessory={opening ? 'chevron' : 'none'}
      onPress={
        opening
          ? () => {
              if ('ref' in opening) openObject(opening.ref);
              else openHref(opening.href);
            }
          : undefined
      }
      position={rowPosition(index, count)}
      accessibilityLabel={[title, line].join(t('common.listSep'))}
    />
  );
}
