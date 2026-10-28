/**
 * Time zones for the automation editor and how a fire time reads in one. React-free
 * (./zones.test.ts). The station accepts any IANA zone (task-center `validateTimezone`).
 */

const FALLBACK_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
];

/** Every zone the browser knows, with UTC and the given ones (the device's, the stored one) included. */
export function timeZoneIds(...include: (string | null | undefined)[]): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  let all: string[] = FALLBACK_ZONES;
  try {
    if (supported) all = supported('timeZone');
  } catch {
    all = FALLBACK_ZONES;
  }
  const extra = ['UTC', ...include.filter((zone): zone is string => !!zone)];
  return [...new Set([...extra, ...all])].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** "GMT+8" for a zone at an instant; '' when the browser cannot say. */
export function zoneOffset(timeZone: string, at: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** "Asia/Taipei · GMT+8" (the offset now; daylight saving moves it). */
export function zoneLabel(timeZone: string, at: number): string {
  const offset = zoneOffset(timeZone, at);
  return offset && offset !== timeZone ? `${timeZone} · ${offset}` : timeZone;
}

/** A fire time as the automation's own clock shows it: "Wed, Oct 28, 09:00" / "10月28日周三 09:00". */
export function runLabel(ms: number, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
