export async function readAssetText(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error('Asset unavailable');
  return response.text();
}
