import React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { usePathname, useRouter, useGlobalSearchParams } from 'expo-router';
import { SheetFrame } from './sheet-actions';
import { useTheme } from '../theme';
import { useShortcut } from './use-shortcut';
import { wideLayout, INSPECTOR_WIDTH } from '../shell/wide-model';
export function sheetEdgeLayout(props: { children: React.ReactElement; route: { name: string } }) {
  return <ScreenFrame route={props.route.name}>{props.children}</ScreenFrame>;
}
function ScreenFrame({ children, route }: { children: React.ReactNode; route: string }) {
  const { width } = useWindowDimensions();
  const layout = wideLayout(width);
  const path = usePathname();
  const router = useRouter();
  const { hex: c, isDark } = useTheme();
  const params = useGlobalSearchParams<{ main?: string }>();
  const promoted = params.main === '1';
  const inspector = !promoted && route.startsWith('sheet/');
  const activeInspector = !promoted && path.startsWith('/sheet/');
  const overlay =
    inspector ||
    [
      'me',
      'doc-new',
      'task-form',
      'tables/new-record',
      'notifications',
      'conversations',
      'move',
      'sheets/stations',
      'sheets/station-add',
    ].includes(route);
  const close = () => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  };
  useShortcut('Escape', close, overlay);
  if (!overlay)
    return (
      <View
        style={{ flex: 1, marginRight: activeInspector && layout.wide && !layout.floatInspector ? INSPECTOR_WIDTH : 0 }}
      >
        {children}
      </View>
    );
  return (
    <View
      style={{
        flex: 1,
        alignItems: inspector && layout.wide ? 'flex-end' : 'center',
        justifyContent: layout.wide ? 'center' : 'flex-end',
        backgroundColor: inspector && layout.wide && !layout.floatInspector ? 'transparent' : c.scrim,
      }}
    >
      {!inspector || !layout.wide || layout.floatInspector ? (
        <Pressable accessibilityLabel="Close" onPress={close} style={{ position: 'absolute', inset: 0 }} />
      ) : null}
      <View
        testID={inspector ? 'client-inspector' : 'client-sheet'}
        style={{
          width: layout.wide ? (inspector ? INSPECTOR_WIDTH : 560) : '100%',
          height: inspector || !layout.wide ? '100%' : '90%',
          maxWidth: '100%',
          borderLeftWidth: 1,
          borderColor: c.separator,
          backgroundColor: c.secondaryGroupedBackground,
          boxShadow: isDark || !layout.wide ? undefined : '-8px 0 32px rgba(0,0,0,.10)',
        }}
      >
        <SheetFrame>{children}</SheetFrame>
      </View>
    </View>
  );
}
