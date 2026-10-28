/** Metro resolves bundled fonts to an asset registry module ID. */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}

/** Text assets (assets/web/*.txt) resolve to an asset registry module ID too. */
declare module '*.txt' {
  const asset: number;
  export default asset;
}

declare module '*.css';

/** Per-icon lucide modules (src/ui/icon-map.ts) ship without their own declarations. */
declare module 'lucide-react/dist/esm/icons/*' {
  const icon: import('lucide-react').LucideIcon;
  export default icon;
}

// Keep optional @expo/ui peer paths (and the native fingerprint) stable. Only this DOM API is used.
declare module 'react-dom' {
  export function createPortal(
    children: import('react').ReactNode,
    container: Element | DocumentFragment,
    key?: string | null,
  ): import('react').ReactPortal;
}
