import React, { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { makeStyles, space, useTheme } from '../theme';

type Footer = { node: React.ReactNode; bare: boolean } | null;

const FooterSlot = createContext<React.Dispatch<React.SetStateAction<Footer>> | null>(null);

/** Screen-owned footer: outside the scrolling form, above the keyboard and safe area. */
export function SheetFrame({ children }: { children: React.ReactNode }) {
  const [footer, setFooter] = useState<Footer>(null);
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  return (
    <FooterSlot.Provider value={setFooter}>
      <View style={styles.frame}>
        <View style={styles.body}>{children}</View>
        {footer?.bare ? (
          footer.node
        ) : footer ? (
          <KeyboardStickyView>
            <View style={[styles.footer, { paddingBottom: Math.max(space.margin, insets.bottom) }]}>{footer.node}</View>
          </KeyboardStickyView>
        ) : null}
      </View>
    </FooterSlot.Provider>
  );
}

/** `bare`: the actions draw their own bar (a web dialog's `.gh-dialog-footer`), not the sheet's padded band. */
export function SheetActions({ children, bare = false }: { children: React.ReactNode; bare?: boolean }) {
  const setFooter = useContext(FooterSlot);
  useEffect(() => {
    if (!setFooter) return;
    setFooter({ node: children, bare });
    return () => setFooter(null);
  }, [children, bare, setFooter]);
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
