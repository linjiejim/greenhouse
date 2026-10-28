/**
 * The frame of the browser entry pages: the brand canvas of the sign-in page, one card, no rail
 * (src/login/entry-links.ts `isStandaloneEntry`). States inside the card use EntryState.
 */

import './entry.css';
import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../theme';
import { Icon, Spinner, type IconName } from '../ui/core';
import { GreenhouseMark } from '../ui/logo';

export function EntryFrame({
  children,
  label,
  testID,
  wide,
}: {
  children: React.ReactNode;
  label: string;
  testID: string;
  wide?: boolean;
}) {
  const { hex } = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title: label }} />
      <div className="gh-entry" style={{ background: hex.brandCanvas }}>
        <main className="gh-entry-card" aria-label={label} data-testid={testID} data-size={wide ? 'wide' : undefined}>
          {children}
        </main>
      </div>
    </>
  );
}

/** The mark, the page's title and what it is about. */
export function EntryHead({ title, detail }: { title: string; detail?: string }) {
  return (
    <header className="gh-entry-head">
      <GreenhouseMark size={56} />
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
    </header>
  );
}

/** Working, done or failed, with the words for it and the way on. */
export function EntryState({
  tone,
  title,
  detail,
  children,
  testID,
}: {
  tone: 'working' | 'success' | 'danger' | 'neutral';
  title: string;
  detail?: string;
  children?: React.ReactNode;
  testID?: string;
}) {
  const { hex } = useTheme();
  const icon: IconName | null =
    tone === 'success' ? 'checkCircle' : tone === 'danger' ? 'alertCircle' : tone === 'neutral' ? 'link' : null;
  return (
    <div className="gh-entry-state" data-testid={testID} data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="gh-entry-badge" data-tone={tone}>
        {icon ? (
          <Icon
            name={icon}
            size={24}
            color={tone === 'success' ? hex.green : tone === 'danger' ? hex.red : hex.accentText}
          />
        ) : (
          <Spinner />
        )}
      </div>
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
      {children}
    </div>
  );
}
