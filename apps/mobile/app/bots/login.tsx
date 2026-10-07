/**
 * `/bots/login?id=&c=` — the secure sign-in sheet behind a sign-in card's
 * "Sign In…" (spec docs/specs/20261008-mobile-bots.md §2.5.5, D11). A SwiftUI
 * form (Android: ./login.android.tsx — no Bots entry there in v1); behaviour
 * in src/bots/cards/use-login-form.ts.
 *
 * Where the values go comes first and is the server's word: the page's real
 * origin (🔒), the page itself when it says more, the Bot's reason. Then the
 * fields — user name and password, or just the code for a one-time-code card
 * (a sign-in card keeps the code behind "Need a code?"):
 * - no `username` / `password` content type: AutoFill would offer — and iOS
 *   would offer to save — the member's own credentials for a third-party site
 *   under Greenhouse's name (the web suppresses browser autofill the same way;
 *   the app has no associated domains, so there is no site to save to);
 * - the code keeps `oneTimeCode`, so a texted code still lands in QuickType;
 *   default keyboard (codes can carry letters);
 * - all three are `privacySensitive` (redacted wherever privacy redaction applies).
 * The native fields own the text; the password and code are cleared before the
 * request is awaited, and everything when the sheet goes. ✓ signs in; "Not
 * Now" tells the Bot the member skipped it; ✕ leaves the card waiting.
 *
 * Only a sign-in card gets the form (any other id reads as gone), and the form
 * is held mounted through its own decision until the sheet is gone
 * (src/bots/cards/login-sheet.ts says why).
 *
 * Fallback if a simulator check ever shows iOS's "Save Password?" after
 * submitting: swap the two fields for an `RNHostView` island of RN
 * `TextInput secureTextEntry textContentType="none" autoComplete="off"` (and
 * note it under AGENTS.md 已知坑).
 */

import React, { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  LabeledContent,
  Section,
  SecureField,
  Text,
  TextField,
  Toggle,
  useNativeState,
  type SecureFieldRef,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  disabled,
  foregroundStyle,
  lineLimit,
  onSubmit,
  privacySensitive,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import type { BotRequestView } from '../../src/shared/bots';
import { loginSheetRequest } from '../../src/bots/cards/login-sheet';
import { useLoginForm, useRequestLookup, type LoginFieldsIO } from '../../src/bots/cards/use-login-form';
import { refusalCopy } from '../../src/bots/cards/decision';
import { useT } from '../../src/lib/i18n';
import { useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';

export default function BotLoginSheet() {
  const t = useT();
  const router = useRouter();
  const { id, c } = useLocalSearchParams<{ id?: string; c?: string }>();
  const lookup = useRequestLookup(id, c);
  // The card this sheet's own decision is out (or went through) for: its form stays until the sheet
  // is gone. A ref read in render, set before the request goes — the decision settles the card in the
  // store (a synchronous re-render) before the awaited call returns, ahead of any state update; a
  // release (nothing decided) re-renders.
  const held = useRef<BotRequestView | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const hold = useCallback((request: BotRequestView | null) => {
    held.current = request;
    if (!request) rerender();
  }, []);
  const done = useCallback(() => router.back(), [router]);

  const request = loginSheetRequest(lookup, held.current);
  if (request) return <LoginForm key={request.id} request={request} onHold={hold} onDone={done} />;
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <SheetClose />
      {lookup.state === 'loading' ? (
        <LoadingState style={{ flex: 1 }} />
      ) : lookup.state === 'error' ? (
        <EmptyState
          icon="alertCircle"
          title={t('bots.needs.loadFailed')}
          message={t('bots.card.err.network')}
          onRetry={lookup.retry}
          style={{ flex: 1 }}
        />
      ) : (
        <EmptyState icon="lock" title={t('bots.login.gone')} message={t('bots.login.goneHint')} style={{ flex: 1 }} />
      )}
    </>
  );
}

function LoginForm({
  request,
  onHold,
  onDone,
}: {
  request: BotRequestView;
  /** Keep this form mounted (a card) or let it go (null) — see BotLoginSheet. */
  onHold: (request: BotRequestView | null) => void;
  /** The decision went through: close the sheet. */
  onDone: () => void;
}) {
  const t = useT();
  const { hex } = useTheme();
  const usernameState = useNativeState('');
  const passwordState = useNativeState('');
  const otpState = useNativeState('');
  const passwordRef = useRef<SecureFieldRef>(null);
  const fields = useMemo<LoginFieldsIO>(
    () => ({
      read: () => ({ username: usernameState.get(), password: passwordState.get(), otp: otpState.get() }),
      clear: (which) => {
        // A native state released with the sheet throws; nothing is left to clear then, and a
        // decision that already went must not fail over it.
        try {
          passwordState.set('');
          otpState.set('');
          if (which === 'all') usernameState.set('');
        } catch {
          // released
        }
      },
    }),
    [usernameState, passwordState, otpState],
  );
  const form = useLoginForm({ request, fields });
  const [showOtp, setShowOtp] = useState(false);
  const origin = form.payload.origin ?? form.payload.url ?? '';
  const reason = typeof form.payload.reason === 'string' ? form.payload.reason.trim() : '';
  const matches = form.payload.vault_matches ?? [];

  // One decision at a time, the form held for its whole flight: a second tap must not release the
  // first one's hold. One that went through keeps the hold (and ignores taps) while the sheet goes.
  const inFlight = useRef(false);
  const decideHeld = async <T,>(decide: () => Promise<T>, wentThrough: (outcome: T) => boolean): Promise<T | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    onHold(request);
    let through = false;
    try {
      const outcome = await decide();
      through = wentThrough(outcome);
      return outcome;
    } finally {
      if (!through) {
        inFlight.current = false;
        onHold(null);
      }
    }
  };

  const submit = async () => {
    const outcome = await decideHeld(form.submit, (o) => o === 'ok' || o === 'stale');
    if (outcome === 'ok' || outcome === 'stale') onDone();
  };
  const skip = async () => {
    const outcome = await decideHeld(form.skip, (o) => o !== null && o.kind !== 'refused');
    if (!outcome) return;
    if (outcome.kind === 'refused') {
      const copy = refusalCopy(outcome);
      alertError(t('bots.card.failedTitle'), 'text' in copy ? copy.text : t(copy.key, copy.vars));
      return;
    }
    onDone();
  };

  const refusal = form.refusal ? refusalCopy(form.refusal) : null;
  const codeField = (
    <TextField
      text={otpState}
      placeholder={t('bots.login.otp')}
      autoFocus={form.otpOnly}
      onTextChange={(value) => form.noteInput('otp', value)}
      modifiers={[
        textContentType('oneTimeCode'),
        autocorrectionDisabled(),
        textInputAutocapitalization('never'),
        privacySensitive(),
        submitLabel('go'),
        onSubmit(() => void submit()),
      ]}
    />
  );

  return (
    <>
      <FormChrome
        title={t('bots.login.title', { host: form.host })}
        dirty={form.dirty}
        canSave={form.canSubmit}
        saving={form.busy !== null}
        onSave={() => void submit()}
        saveLabel={t('bots.login.submit')}
      />
      <NativeForm>
        <Section footer={reason ? <Text>{reason}</Text> : undefined}>
          {origin ? (
            <LabeledContent label={t('bots.card.site')}>
              <HStack spacing={4}>
                <Image systemName="lock.fill" size={12} color={hex.secondaryLabel} />
                <Text modifiers={[lineLimit(1), truncationMode('middle')]}>{origin}</Text>
              </HStack>
            </LabeledContent>
          ) : null}
          {form.page ? (
            <LabeledContent label={t('bots.card.page')}>
              <Text modifiers={[lineLimit(2), truncationMode('middle')]}>{form.page}</Text>
            </LabeledContent>
          ) : null}
        </Section>

        {/* The footer is always a Text (the refusal in red, else what the values are used for):
            adding / removing a footer rebuilds the section and the focused field loses focus. */}
        <Section
          footer={
            <Text modifiers={refusal ? [foregroundStyle(hex.red)] : []}>
              {refusal ? ('text' in refusal ? refusal.text : t(refusal.key, refusal.vars)) : t('bots.login.footer')}
            </Text>
          }
        >
          {form.otpOnly ? (
            codeField
          ) : (
            <>
              <TextField
                text={usernameState}
                placeholder={t('bots.login.username')}
                autoFocus
                onTextChange={(value) => form.noteInput('username', value)}
                modifiers={[
                  autocorrectionDisabled(),
                  textInputAutocapitalization('never'),
                  privacySensitive(),
                  submitLabel('next'),
                  onSubmit(() => void passwordRef.current?.focus()),
                ]}
              />
              <SecureField
                ref={passwordRef}
                text={passwordState}
                placeholder={t('bots.login.password')}
                onTextChange={(value) => form.noteInput('password', value)}
                modifiers={[privacySensitive(), submitLabel('go'), onSubmit(() => void submit())]}
              />
              <DisclosureGroup label={t('bots.login.needOtp')} isExpanded={showOtp} onIsExpandedChange={setShowOtp}>
                {codeField}
              </DisclosureGroup>
            </>
          )}
        </Section>

        {form.vaultOffered ? (
          <Section
            footer={
              matches.length > 0 ? (
                <Text>
                  {matches.map((m) => t('bots.card.vaultHas', { label: m.label, hint: m.username_hint })).join('\n')}
                </Text>
              ) : undefined
            }
          >
            <Toggle label={t('bots.login.saveToVault')} isOn={form.save} onIsOnChange={form.setSave} />
          </Section>
        ) : null}

        <Section>
          <Button
            label={t('bots.card.loginNotNow')}
            onPress={() => void skip()}
            modifiers={[disabled(form.busy !== null)]}
          />
        </Section>
      </NativeForm>
    </>
  );
}
