import { Platform, type ViewProps } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';

export const hasFilePreview = Platform.OS === 'ios' && requireOptionalNativeModule('FilePreview') != null;
export const FilePreviewView: ComponentType<ViewProps & { uri: string; onUnsupported: () => void }> | null =
  hasFilePreview ? requireNativeView('FilePreview') : null;
