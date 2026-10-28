import { invoke, reportNativeError } from '../desktop/native';
/** Serialize writes per key so a quick sign-out cannot be overtaken by a slow save. */
const remembered = new Map<string, string | null>();
const writes = new Map<string, Promise<void>>();
export const flushCredentials = async () => {
  await Promise.all(writes.values());
};
const preference = (key: string) => key.startsWith('greenhouse_pref_');
export async function persistGet(key: string): Promise<string | null> {
  if (preference(key)) return localStorage.getItem(`greenhouse_desktop:${key}`);
  await writes.get(key);
  const value = await invoke<string | null>('plugin:credentials|read', { key });
  remembered.set(key, value);
  return value;
}
export function persistSet(key: string, value: string | null): void {
  if (preference(key)) {
    if (value == null) localStorage.removeItem(`greenhouse_desktop:${key}`);
    else localStorage.setItem(`greenhouse_desktop:${key}`, value);
    return;
  }
  if (!writes.has(key) && remembered.has(key) && remembered.get(key) === value) return;
  const pending = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await invoke('plugin:credentials|write', { key, value });
      remembered.set(key, value);
      if (key.startsWith('greenhouse_refresh_token__') || key.startsWith('greenhouse_member__'))
        localStorage.setItem('greenhouse_desktop:session_revision', String(Date.now()) + Math.random());
    });
  writes.set(key, pending);
  void pending.catch(reportNativeError).finally(() => {
    if (writes.get(key) === pending) writes.delete(key);
  });
}
