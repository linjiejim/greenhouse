import React, { type ComponentProps } from 'react';
import { Text } from '@expo/ui/jetpack-compose';

/** Native Compose text, retaining its M3 role and system font scaling. */
export function BrandText({ style, ...props }: ComponentProps<typeof Text>) {
  return <Text {...props} style={{ fontFamily: 'Nunito', ...style }} />;
}
