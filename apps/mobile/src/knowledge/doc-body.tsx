/**
 * The read-only body of a knowledge doc, shared by the full page
 * (app/knowledge/[slug].tsx) and the bottom-sheet peek (app/peek/doc/[slug].tsx):
 *
 *  - `DocMeta`  — one footnote line: scope glyph · scope · category · updated
 *    time · author (when the name is resolvable),
 *  - `DocTags`  — the doc's tags as accent `Badge`s,
 *  - `DocBody`  — meta + tags + the Markdown content (the shared chat renderer).
 *
 * Plain content-layer views (no glass); the host screen owns the scroll view.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { docTags, type KnowledgeDoc } from '../api/knowledge';
import { Markdown } from '../chat/markdown';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme } from '../theme';
import { Icon } from '../ui/core';
import { Badge } from '../ui/list';
import { SCOPE_ICON, SCOPE_LABEL, docCategory, docScope, scopeTint } from './scope';
import { useUserName } from './use-user-names';

/**
 * Drop a leading `# <title>` heading that just repeats the doc title (docs
 * written on the web usually start with one) — the screen already shows the
 * title, so rendering it again reads as a stutter.
 */
export function withoutTitleHeading(markdown: string, title: string): string {
  const m = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  return m && m[1].trim() === title.trim() ? markdown.slice(m[0].length) : markdown;
}

export function DocMeta({ doc }: { doc: KnowledgeDoc }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const userName = useUserName();
  const scope = docScope(doc);
  const author = userName(doc.updated_by ?? doc.created_by);
  const parts = [t(SCOPE_LABEL[scope]), docCategory(doc), relativeTime(doc.updated_at), author].filter(Boolean);
  return (
    <View style={styles.meta} accessible accessibilityLabel={parts.join(', ')}>
      <Icon name={SCOPE_ICON[scope]} size={13} weight="medium" color={scopeTint(scope, c).fg} />
      <Text style={styles.metaText} numberOfLines={2}>
        {parts.join(' · ')}
        {doc.access === 'reader' ? ` · ${t('knowledge.readOnly')}` : ''}
      </Text>
    </View>
  );
}

export function DocTags({ doc }: { doc: KnowledgeDoc }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const tags = docTags(doc);
  if (tags.length === 0) return null;
  return (
    <View style={styles.tags}>
      {tags.map((tag) => (
        <Badge key={tag} label={tag} tone="accent" />
      ))}
    </View>
  );
}

export function DocBody({ doc }: { doc: KnowledgeDoc }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const source = withoutTitleHeading(doc.content_markdown || doc.summary || '', doc.title);
  return (
    <View>
      <DocMeta doc={doc} />
      <DocTags doc={doc} />
      <View style={styles.body}>
        {source.trim() ? <Markdown source={source} /> : <Text style={styles.emptyBody}>{t('knowledge.emptyDoc')}</Text>}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  metaText: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 1 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, marginTop: space.sm + 2 },
  body: { marginTop: space.lg },
  emptyBody: { ...typo.body, color: c.tertiaryLabel },
}));
