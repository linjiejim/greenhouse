import { File } from 'expo-file-system';
export const readAssetText = (uri: string) => new File(uri).text();
