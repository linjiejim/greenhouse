/**
 * 连接 Agent (「我」 → 我的 Agent → 连接 Agent): step by step, how to point an MCP client (Claude
 * Code, Codex, Cursor or any other) at this station's `/api/mcp`. Pick the client, copy its own
 * setup (sign-in is OAuth discovery: the client opens the consent page itself), check that it
 * reached the station (`/api/agent-access/connections`), then tips. Clients that can use the model
 * gateway get its snippet too. Rules in src/agent/connect-guide.ts; nothing here holds a secret.
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { agentAccessOverview, gatewayOverview, listConnections } from '../../src/api/agent';
import {
  AGENT_CLIENTS,
  connectionVerdict,
  gatewayGuide,
  mcpUrlOf,
  setupSnippets,
  type AgentClientKind,
  type ConnectionVerdict,
} from '../../src/agent/connect-guide';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { CodeBlock } from '../../src/markdown/blocks/code';
import { getApiBase } from '../../src/store/stations';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { Row, Section, SectionFooter, SectionHeader } from '../../src/ui/list';
import { Screen } from '../../src/ui/screen';

type Check =
  | { state: 'idle' | 'checking' }
  | { state: 'done'; verdict: ConnectionVerdict }
  | { state: 'failed'; message: string };

export default function ConnectAgent() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const overview = useResource(useCallback(() => agentAccessOverview(), []));
  const gateway = useResource(useCallback(() => gatewayOverview(), []));
  const [client, setClient] = useState<AgentClientKind | null>(null);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const mcpUrl = mcpUrlOf(overview.data, getApiBase());

  const pick = (kind: AgentClientKind) => {
    setClient(kind);
    setCheck({ state: 'idle' });
  };
  const runCheck = async () => {
    if (!client) return;
    setCheck({ state: 'checking' });
    const answer = await listConnections();
    setCheck(
      answer.ok
        ? { state: 'done', verdict: connectionVerdict(answer.data, client) }
        : { state: 'failed', message: answer.message || t('agentConnect.checkFailed') },
    );
  };
  const verdictText = (verdict: ConnectionVerdict) =>
    verdict.kind === 'ok'
      ? t('agentConnect.checkOk', { name: verdict.name, ago: relativeTimeNow(verdict.at) })
      : verdict.kind === 'stale'
        ? t('agentConnect.checkStale', { name: verdict.name, ago: relativeTimeNow(verdict.at) })
        : verdict.kind === 'never'
          ? t('agentConnect.checkNever', { name: verdict.name })
          : t('agentConnect.checkNone');
  const guide = client && gateway.data ? gatewayGuide(client, gateway.data) : null;

  return (
    <>
      <Screen title={t('agentConnect.title')} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <SectionFooter text={t('agentConnect.intro')} style={styles.intro} />

        <Section header={t('agentConnect.pickTitle')}>
          {AGENT_CLIENTS.map((kind) => (
            <Row
              key={kind}
              title={t(`agentConnect.client.${kind}`)}
              icon={kind === 'other' ? 'link' : 'sparkle'}
              accessory={client === kind ? 'check' : 'none'}
              onPress={() => pick(kind)}
              accessibilityLabel={t(`agentConnect.client.${kind}`)}
            />
          ))}
        </Section>

        {client ? (
          <>
            <SectionHeader title={t('agentConnect.setupTitle')} />
            <View style={styles.block} testID="connect-setup">
              <Text style={styles.caption}>{t('agentConnect.endpoint')}</Text>
              <CodeBlock lang="url" code={mcpUrl} />
              {setupSnippets(client, mcpUrl)
                .filter((snippet) => snippet.code !== mcpUrl)
                .map((snippet) => (
                  <View key={snippet.kind} style={styles.snippet}>
                    <Text style={styles.caption}>{t(`agentConnect.snippet.${snippet.kind}`)}</Text>
                    <CodeBlock lang={snippet.lang} code={snippet.code} />
                  </View>
                ))}
              <Text style={styles.note}>{t(`agentConnect.signIn.${client}`)}</Text>
              <Text style={styles.note}>{t('agentConnect.scopes')}</Text>
            </View>

            <Section
              header={t('agentConnect.checkTitle')}
              footer={
                check.state === 'done'
                  ? verdictText(check.verdict)
                  : check.state === 'failed'
                    ? check.message
                    : t('agentConnect.checkIntro')
              }
            >
              <Row
                title={check.state === 'checking' ? t('agentConnect.checking') : t('agentConnect.check')}
                icon="refresh"
                accessory="none"
                disabled={check.state === 'checking'}
                onPress={() => void runCheck()}
              />
            </Section>

            {guide ? (
              <>
                <SectionHeader title={t('agentConnect.gatewayTitle')} />
                <View style={styles.block}>
                  {guide.kind === 'snippet' ? (
                    <>
                      <Text style={styles.note}>{t('agentConnect.gatewayIntro')}</Text>
                      <CodeBlock lang={guide.lang} code={guide.code} />
                      <Text style={styles.note}>{t('agentConnect.gatewayKey')}</Text>
                    </>
                  ) : (
                    <Text style={styles.note}>{t(`agentConnect.gatewayNote.${guide.kind}`)}</Text>
                  )}
                </View>
              </>
            ) : null}

            <SectionHeader title={t('agentConnect.tipsTitle')} />
            <View style={styles.block}>
              {(['tipTeamContext', 'tipPrompts', 'tipCatalog'] as const).map((key) => (
                <Text key={key} style={styles.note}>
                  {`• ${t(`agentConnect.${key}`)}`}
                </Text>
              ))}
            </View>
          </>
        ) : (
          <SectionFooter text={t('agentConnect.pickFirst')} />
        )}

        <SectionHeader title={t('agentConnect.howWrites')} />
        <View style={styles.block}>
          {(['howWrites1', 'howWrites2', 'howWrites3', 'howWrites4'] as const).map((key) => (
            <Text key={key} style={styles.note}>
              {`• ${t(`agentConnect.${key}`)}`}
            </Text>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  intro: { marginTop: space.md },
  block: { marginHorizontal: space.margin, gap: space.sm, marginBottom: space.lg },
  snippet: { gap: space.xs },
  caption: { ...typo.footnote, color: c.secondaryLabel },
  note: { ...typo.footnote, color: c.secondaryLabel },
}));
