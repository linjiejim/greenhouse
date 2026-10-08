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
 * iOS still reads a username field next to a SecureField as a login and
 * offered "Save Password?" when the sheet closed with them filled (simulator,
 * 2026-10-08) — leaving the content types off is not enough. However the
 * sheet goes, `beforeRemove` empties every field and dismisses the keyboard
 * first, so there is nothing to save (and no focused field inside a deleted
 * Form section, which UIKit throws on).
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import {
  Button,
  DisclosureGroup,
  HStack,
  Image,
  LabeledContent,
  ProgressView,
  Section,
  SecureField,
  Spacer,
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
import { EmptyState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { BotsRouteGate } from '../../src/bots/route-gate';

type Chrome = React.ComponentProps<typeof FormChrome>;

/** Closed Bots (switched off, refused) → home + "unavailable"; `latched`: src/bots/route-gate.tsx. */
export default function BotLoginRoute() {
  return (
    <BotsRouteGate kind="threads" latched>
      <BotLoginSheet />
    </BotsRouteGate>
  );
}

function BotLoginSheet() {
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

  // ✕ / ✓ for the card's form (handed up by LoginSections: nav chrome can't sit among the Form's
  // SwiftUI children).
  const [chrome, setChrome] = useState<Chrome | null>(null);

  const request = loginSheetRequest(lookup, held.current);
  // The Form is mounted from the first frame, loading included: a SwiftUI Form that
  // only mounts once the sheet is up doesn't get the nav bar's top inset, and its
  // first (untitled) section slides under the bar.
  const failed = !request && lookup.state !== 'loading';
  return (
    <>
      {chrome && request ? (
        <FormChrome {...chrome} />
      ) : (
        <>
          <Stack.Screen options={{ title: '' }} />
          <SheetClose />
        </>
      )}
      {failed ? (
        lookup.state === 'error' ? (
          <EmptyState
            icon="alertCircle"
            title={t('bots.needs.loadFailed')}
            message={t('bots.card.err.network')}
            onRetry={lookup.retry}
            style={{ flex: 1 }}
          />
        ) : (
          <EmptyState icon="lock" title={t('bots.login.gone')} message={t('bots.login.goneHint')} style={{ flex: 1 }} />
        )
      ) : (
        <NativeForm>
          {request ? (
            <LoginSections key={request.id} request={request} onHold={hold} onDone={done} onChrome={setChrome} />
          ) : (
            <Section>
              <HStack>
                <Spacer />
                <ProgressView />
                <Spacer />
              </HStack>
            </Section>
          )}
        </NativeForm>
      )}
    </>
  );
}

function LoginSections({
  request,
  onHold,
  onDone,
  onChrome,
}: {
  request: BotRequestView;
  /** Keep this form mounted (a card) or let it go (null) — see BotLoginSheet. */
  onHold: (request: BotRequestView | null) => void;
  /** The decision went through: close the sheet. */
  onDone: () => void;
  /** The sheet draws ✕ / ✓ outside the Form: this form's state for them (null once it is gone). */
  onChrome: (chrome: Chrome | null) => void;
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

  // However the sheet goes (✕, discard, swipe, a decision), empty the fields and let the focused
  // one go before its sections are torn down (both seen on the simulator, 2026-10-08):
  // - iOS offers "Save Password?" when a view holding a filled secure field disappears — it would
  //   keep a third-party site's credentials under Greenhouse's name; empty fields leave nothing to save;
  // - UIKit throws ("the first responder contained inside of a deleted section … refused to resign")
  //   when a Form section is deleted while its text field still has focus.
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        fields.clear('all');
        Keyboard.dismiss();
      }),
    [navigation, fields],
  );
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

  // ✓ runs the latest `submit` (it reads this render's form).
  const latestSubmit = useRef(submit);
  useLayoutEffect(() => {
    latestSubmit.current = submit;
  });
  const title = t('bots.login.title', { host: form.host });
  const saveLabel = t('bots.login.submit');
  const { dirty, canSubmit } = form;
  const saving = form.busy !== null;
  useLayoutEffect(() => {
    onChrome({ title, dirty, canSave: canSubmit, saving, onSave: () => void latestSubmit.current(), saveLabel });
    return () => onChrome(null);
  }, [onChrome, title, dirty, canSubmit, saving, saveLabel]);

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
    </>
  );
}
