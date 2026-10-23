import React, { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { makeStyles, space, useTheme } from '../theme';

const FooterSlot = createContext<React.Dispatch<React.SetStateAction<React.ReactNode>> | null>(null);

/** Screen-owned footer: outside the scrolling form, above the keyboard and safe area. */
export function SheetFrame({ children }: { children: React.ReactNode }) {
  const [footer, setFooter] = useState<React.ReactNode>(null);
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  return (
    <FooterSlot.Provider value={setFooter}>
      <View style={styles.frame}>
        <View style={styles.body}>{children}</View>
        {footer ? (
          <KeyboardStickyView>
            <View style={[styles.footer, { paddingBottom: Math.max(space.margin, insets.bottom) }]}>{footer}</View>
          </KeyboardStickyView>
        ) : null}
      </View>
    </FooterSlot.Provider>
  );
}

export function SheetActions({ children }: { children: React.ReactNode }) {
  const setFooter = useContext(FooterSlot);
  useEffect(() => {
    if (!setFooter) return;
    setFooter(children);
    return () => setFooter(null);
  }, [children, setFooter]);
  return setFooter ? null : <View>{children}</View>;
}

const useStyles = makeStyles((c) => ({
  frame: { flex: 1 },
  body: { flex: 1, minHeight: 0 },
  footer: {
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.md,
    backgroundColor: c.secondaryGroupedBackground,
    borderTopWidth: 1,
    borderTopColor: c.separator,
  },
}));
