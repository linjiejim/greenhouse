/** Content-Disposition names shared by native and browser authenticated previews. */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  if (disposition) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1]);
      } catch {
        /* use plain name */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain) return plain[1];
  }
  return fallback;
}
