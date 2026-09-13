/**
 * WeCom (企业微信) group-bot notification primitive.
 *
 * The single low-level "post a markdown message to a group-bot webhook" call,
 * shared by every notifier (sync results, knowledge comments/@-mentions, …) so
 * there is one place that knows the WeCom payload shape. Higher-level notifiers
 * format the markdown; this just delivers it. Never throws — returns a result so
 * a failed notification never breaks the action that triggered it.
 *
 * Note: group-bot markdown does NOT support real @-pings (that needs the `text`
 * msgtype + WeCom userids); callers name people in the markdown and rely on the
 * deeplink instead.
 */
export interface WeComSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function sendWeComMarkdown(webhookUrl: string, content: string): Promise<WeComSendResult> {
  if (!webhookUrl) return { ok: false, error: 'no webhook url' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
