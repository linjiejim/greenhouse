/** Picked browser previews own their object URLs. */
export function releaseLocalFile(uri: string): void {
  if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
}
