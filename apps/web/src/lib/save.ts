/** Saves a blob as a file through a temporary link; the browser decides where it goes. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // A large file may still be reading from the blob after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
