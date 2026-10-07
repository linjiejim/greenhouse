/**
 * A proposed Bot, before it exists: its face (the proposal's avatar resolved
 * the web's way), name and role, and the start of its instructions — whole in
 * the card sheet. Nothing is created until the member presses Create (a Bot
 * persisting a new identity on its own would let a prompt-injected page plant
 * a permanent helper); "Edit First" opens the Bot form with the proposal.
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { BotCreatePayload, BotRequestView } from '../../shared/bots';
import { space, typo, useTheme } from '../../theme';
import { BotAvatar } from '../ui/bot-avatar';

export function BotCreateBody({ request, full = false }: { request: BotRequestView; full?: boolean }) {
  const { colors: c } = useTheme();
  const payload = request.payload as BotCreatePayload;
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <BotAvatar
          // The proposal has no id yet: the request's stands in for the resolver's stable seed.
          bot={{ id: request.id, avatar: payload.avatar, template_key: payload.template_key }}
          size={44}
          animate={false}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ ...typo.headline, color: c.label }} numberOfLines={2}>
            {payload.name}
          </Text>
          {payload.role ? (
            <Text style={{ ...typo.subheadline, color: c.secondaryLabel }} numberOfLines={2}>
              {payload.role}
            </Text>
          ) : null}
        </View>
      </View>
      {instructions ? (
        <Text
          style={{ ...typo.footnote, color: c.secondaryLabel }}
          numberOfLines={full ? undefined : 3}
          selectable={full}
        >
          {instructions}
        </Text>
      ) : null}
    </>
  );
}
