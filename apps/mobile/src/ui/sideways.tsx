/**
 * Read a wide table sideways without turning the app: a full-screen cover whose content is the
 * grid rotated a quarter turn (the phone's long edge becomes the table's width), scrolling both
 * ways. The app stays portrait (no orientation change, no relayout of the page underneath); the
 * member turns the phone to read and taps ✕ (or swipes the grid back) to return. UIKit rotates
 * touches with the view, so scrolling follows the turned grid.
 */

import React, { useState } from 'react';
import { Modal, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TableGrid, type TableData } from '../markdown';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../theme';
import { Icon, Touchable } from './core';

export function SidewaysTable({
  data,
  title,
  visible,
  onClose,
}: {
  data: TableData | null;
  title: string;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [avail, setAvail] = useState(0);
  // turned clockwise: the content's top runs along the phone's right edge, its leading edge
  // along the top (the camera housing), its trailing edge along the home indicator
  const lead = Math.max(insets.top, space.margin);
  const trail = Math.max(insets.bottom, space.margin);
  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={['portrait']}
      onRequestClose={onClose}
    >
      <View style={styles.root}>
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
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  turned: { position: 'absolute', transform: [{ rotate: '90deg' }] },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: HIT, marginTop: space.sm, gap: space.sm },
  title: { ...typo.headline, fontWeight: weight.semibold, color: c.label, flex: 1 },
  close: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  content: { paddingBottom: space.xl },
}));
