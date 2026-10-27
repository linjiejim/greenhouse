/**
 * Read a wide table sideways without turning the app: a full-screen cover whose content is the
 * grid rotated a quarter turn (the phone's long edge becomes the table's width), scrolling both
 * ways. The app stays portrait (no orientation change, no relayout of the page underneath); the
 * member turns the phone to read and taps ✕ (or swipes the grid back) to return. UIKit rotates
 * touches with the view, so scrolling follows the turned grid.
 */

import React, { useState } from 'react';
import { Modal, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { TableGrid, type TableData } from '../markdown';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon, Touchable } from './core';

interface SidewaysProps {
  data: TableData | null;
  title: string;
  visible: boolean;
  onClose: () => void;
}

export function SidewaysTable(props: SidewaysProps) {
  return (
    <Modal
      visible={props.visible}
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={['portrait']}
      onRequestClose={props.onClose}
    >
      {/* its own provider: the presenting screen's insets are not the modal's (a bar under it once made the bottom 83, not the home indicator's 34) */}
      <SafeAreaProvider>
        <Turned {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}

function Turned({ data, title, onClose }: SidewaysProps) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [avail, setAvail] = useState(0);
  // the cover's real size (a modal can differ from the window by a bar): the turned box swaps it
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);
  const { width, height } = screen ?? window;
  // turned clockwise: the content's top runs along the phone's right edge, its leading edge
  // along the top (the camera housing), its trailing edge along the home indicator
  const lead = Math.max(insets.top, space.margin);
  const trail = Math.max(insets.bottom, space.margin);
  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        if (w && h && (w !== screen?.width || h !== screen?.height)) setScreen({ width: w, height: h });
      }}
    >
      <View
        style={[
          styles.turned,
          {
            width: height,
            height: width,
            left: (width - height) / 2,
            top: (height - width) / 2,
            paddingLeft: lead,
            paddingRight: trail,
            // the turned top and bottom run along the phone's side edges (no insets in portrait)
            paddingTop: Math.max(insets.right, space.sm),
            paddingBottom: Math.max(insets.left, space.sm),
          },
        ]}
      >
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <Touchable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={styles.close}
          >
            <Icon name="x" size={17} color={c.secondaryLabel} />
          </Touchable>
        </View>
        {data ? (
          <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
            {/* the grid scrolls sideways itself */}
            <View onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
              <TableGrid data={data} big avail={avail || undefined} />
            </View>
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.background },
  turned: { position: 'absolute', transform: [{ rotate: '90deg' }] },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: HIT, gap: space.sm },
  title: { ...typo.headline, fontWeight: weight.semibold, color: c.label, flex: 1 },
  close: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  content: { paddingBottom: space.xl },
}));
