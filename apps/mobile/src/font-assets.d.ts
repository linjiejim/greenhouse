/** Metro resolves bundled fonts to an asset registry module ID. */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
