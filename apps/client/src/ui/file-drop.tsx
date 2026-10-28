import React from 'react';
import { View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
export function FileDrop({ children }: { children: React.ReactNode; onFiles?: (files: unknown[]) => void }) {
  return <View>{children}</View>;
}
export async function pickFile() {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  return result.canceled ? [] : result.assets;
}
