export function fileStem(name: string | undefined, fallback: string) {
  return (name || fallback).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100);
}
export async function shareTextFile(name: string, text: string, type: string): Promise<boolean> {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
