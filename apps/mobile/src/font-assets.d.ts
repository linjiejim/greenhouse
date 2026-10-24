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
