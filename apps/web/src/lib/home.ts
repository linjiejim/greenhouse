/**
 * Home's rules (React-free, see ./home.test.ts): the greeting for the hour and
 * how many recent conversations the new-conversation screen lists.
 *
 * `greetingFor` is a copy of the iOS app's (apps/client/src/data/home.ts): the
 * mobile app is not in the workspace, so the two are kept equal by their tests.
 * The recent count is a per-device choice kept in localStorage, never an account
 * preference (spec D3).
 */

export type Greeting = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

/** The name a greeting uses: the nickname's first word, else the email's local part. */
export function greetingName(user: { nickname?: string | null; email?: string | null } | null | undefined): string {
  const nickname = user?.nickname?.trim();
  if (nickname) return nickname.split(/\s+/)[0];
  return user?.email?.split('@')[0] ?? '';
}

/** How many recent conversations Home lists; 0 lists none. */
export const HOME_RECENT_CHOICES = [0, 3, 5, 10] as const;
export type HomeRecent = (typeof HOME_RECENT_CHOICES)[number];
export const DEFAULT_HOME_RECENT: HomeRecent = 5;
export const HOME_RECENT_STORAGE_KEY = 'home-recent-count';

/** A saved choice, or null when it is not one of HOME_RECENT_CHOICES. */
export function homeRecentOf(raw: string | null | undefined): HomeRecent | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return (HOME_RECENT_CHOICES as readonly number[]).includes(n) ? (n as HomeRecent) : null;
}

export function readHomeRecent(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): HomeRecent {
  try {
    return homeRecentOf(storage?.getItem(HOME_RECENT_STORAGE_KEY)) ?? DEFAULT_HOME_RECENT;
  } catch {
    return DEFAULT_HOME_RECENT;
  }
}

export function writeHomeRecent(
  value: HomeRecent,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(HOME_RECENT_STORAGE_KEY, String(value));
  } catch {
    /* private mode / quota — the default still applies */
  }
}
