/**
 * JS face of the NativeChart module (iOS only): a chart block drawn by Swift
 * Charts (ios/NativeChartView.swift) — bar and line (grouped series, legend,
 * tap a label for its values), pie and doughnut (iOS 17). The chart block
 * (src/chat/markdown/blocks/chart.tsx) asks `nativeChartSupports(type)` and
 * otherwise draws its SVG chart — the radar, Android, and binaries built
 * before this module (an OTA update can't add native code).
 *
 * `NativeChartView` is a SwiftUI view: it only renders inside a `Host` from
 * `@expo/ui/swift-ui` (the caller sizes the Host and gives it the app's color
 * scheme and locale).
 */

import React from 'react';
import { Platform } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

export type NativeChartType = 'bar' | 'line' | 'pie' | 'doughnut';

export interface NativeChartViewProps {
  type: NativeChartType;
  labels: string[];
  /** Series names must be unique (they key the legend and the colors). */
  series: { label: string; data: number[]; color: string }[];
  /** Pie / doughnut: one color per label. */
  sliceColors?: string[];
  /** Print each bar's value above it. */
  valueLabels?: boolean;
  /** Under the plot until a label is tapped. */
  hint?: string;
}

const present = Platform.OS === 'ios' && requireOptionalNativeModule('NativeChart') != null;
const NativeView: React.ComponentType<NativeChartViewProps> | null = present
  ? requireNativeView<NativeChartViewProps>('NativeChart')
  : null;
const iosMajor = Platform.OS === 'ios' ? parseInt(String(Platform.Version), 10) || 0 : 0;

/** This binary draws this chart natively: bar / line (iOS 16.4+, the app's floor), pie / doughnut from iOS 17. */
export function nativeChartSupports(type: string): type is NativeChartType {
  if (!NativeView) return false;
  if (type === 'bar' || type === 'line') return true;
  if (type === 'pie' || type === 'doughnut') return iosMajor >= 17;
  return false;
}

/** The SwiftUI chart — put it in a `Host`. */
export function NativeChartView(props: NativeChartViewProps) {
  return NativeView ? <NativeView {...props} /> : null;
}
