import React from 'react';
import { ScrollView } from 'react-native';
import { Row, Section } from './list';
export const DetailFields = Section;
export const DetailScroll = ScrollView;
export function DetailField({ label, value, last }: { label: string; value: string; kind: string; last?: boolean }) {
  return <Row last={last} title={label} subtitle={value || '—'} subtitleLines={8} accessory="none" />;
}
