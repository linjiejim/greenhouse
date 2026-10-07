/**
 * Ambient module for @novnc/novnc (the package ships ESM without declarations).
 *
 * The package's `exports` map only exposes the root (`./core/rfb.js`), so the
 * import specifier is the bare package name — `@novnc/novnc/core/rfb.js` would
 * be rejected by Vite's exports resolution. Types live in ./types.ts.
 */

declare module '@novnc/novnc' {
  const RFB: import('./types').RfbConstructor;
  export default RFB;
}
