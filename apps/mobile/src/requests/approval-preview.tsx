import { useState } from 'react';
import { View } from 'react-native';
import { Markdown } from '../chat/markdown';
import { useT } from '../lib/i18n';
import { NativeButton } from '../ui/button';

const PREVIEW_HEIGHT = 240;

export function ApprovalPreview({ source }: { source: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(0);
  return (
    <View>
      <View style={!expanded ? { maxHeight: PREVIEW_HEIGHT, overflow: 'hidden' } : undefined}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <Markdown source={source} preview />
        </View>
      </View>
      {height > PREVIEW_HEIGHT ? (
        <NativeButton
          label={t(expanded ? 'requests.collapsePreview' : 'requests.expandPreview')}
          onPress={() => setExpanded(!expanded)}
        />
      ) : null}
    </View>
  );
}
