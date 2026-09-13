/**
 * Feishu (飞书) group-bot notification primitive.
 *
 * The single low-level "post a markdown card to a custom-bot webhook" call —
 * the Feishu sibling of `sendWeComMarkdown`. Higher-level notifiers format the
 * markdown; this just delivers it. Never throws — returns a result so a failed
 * notification never breaks the action that triggered it.
 *
 * Feishu webhooks answer HTTP 200 even for many failures, with the real
 * verdict in the JSON `code` field — both layers are checked.
 */
export interface FeishuSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function sendFeishuMarkdown(webhookUrl: string, content: string): Promise<FeishuSendResult> {
  if (!webhookUrl) return { ok: false, error: 'no webhook url' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        // Card JSON **2.0** — 1.0's markdown component emits ATX headings and
        // GFM tables as literal text (`## Title`, `| a | b |` reach the reader
        // as raw syntax). 2.0 renders the full GitHub-flavored set, which is
        // what the notification pipeline produces. Same version as the DM path
        // in apps/api/src/feishu/client.ts; keep the two in step.
        card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content }] } },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (body.code) return { ok: false, status: res.status, error: `${body.code} ${body.msg ?? ''}`.trim() };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
