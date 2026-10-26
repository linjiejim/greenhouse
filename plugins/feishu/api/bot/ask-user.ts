/**
 * 把 `ask_user` 的提问渲染进飞书回复正文。
 *
 * **为什么需要这个**：`ask_user` 的 `presentation: 'artifact'` —— 问题内容
 * 不进 assistant 正文，靠 Web 前端的 `AskUserCard` 渲染。而飞书面只取
 * `result.text`，于是模型问了问题、用户却只看到一句引导语，**问的是什么、有
 * 哪些选项，全都不可见**。工具在工具集里而它的产物在这个面上无法呈现，就是
 * 「能力声明必须真实」被违反。
 *
 * **为什么是正文而不是卡片按钮**：IM 里打字回答本来就是最自然的交互，而正文
 * 渲染让「不离开飞书」立刻成立——用户看到问题，用飞书的「回复」回答，既有的
 * 会话延续机制（root_id）原样接住，零新状态、零新表。单选题加按钮是这之上的
 * 便利，不是前提；真要加时它替代的只是「打字」，不是「看得见问题」。
 *
 * 零 import 叶子模块（同 conversation-key.ts 的理由）。
 */

/** `ask_user` 工具输出的形状——模型写的，所以每个字段都要验，不能信。 */
interface AskUserOption {
  value: string;
  label: string;
}

interface AskUserQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: AskUserOption[];
  required?: boolean;
  placeholder?: string;
}

interface AskUserOutput {
  type: 'ask_user';
  title?: string;
  description?: string;
  questions: AskUserQuestion[];
}

function isAskUserOutput(value: unknown): value is AskUserOutput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AskUserOutput>;
  if (v.type !== 'ask_user' || !Array.isArray(v.questions) || v.questions.length === 0) return false;
  // 只要有一条能用就渲染——模型写坏一题不该让整组问题消失。
  return v.questions.some((q) => q && typeof q.label === 'string' && q.label.trim().length > 0);
}

function renderOptions(q: AskUserQuestion): string[] {
  if (!Array.isArray(q.options) || q.options.length === 0) return [];
  const many = q.type === 'multi_choice';
  const lines = q.options.filter((o) => o && typeof o.label === 'string').map((o, i) => `   ${i + 1}. ${o.label}`);
  if (lines.length === 0) return [];
  return [...lines, many ? '   *（可多选，回复序号或选项名，用顿号分隔）*' : ''];
}

/**
 * 从一轮的工具证据里找出 `ask_user`，渲染成飞书能读的 markdown。
 *
 * 返回 null 表示这一轮没有提问——调用方照常只发正文。
 */
export function renderAskUserFromEvidence(
  evidence: ReadonlyArray<{ toolName: string; output: unknown }>,
): string | null {
  // 一轮里模型可能问了不止一次；全部渲染，漏掉任何一组都是同一个 bug。
  const asks = evidence.filter((e) => e.toolName === 'ask_user' && isAskUserOutput(e.output));
  if (asks.length === 0) return null;

  const blocks: string[] = [];
  for (const ask of asks) {
    const out = ask.output as AskUserOutput;
    const lines: string[] = [];
    lines.push(`**❓ ${out.title?.trim() || '需要你确认几件事'}**`);
    if (out.description?.trim()) lines.push('', out.description.trim());
    lines.push('');

    let n = 0;
    for (const q of out.questions) {
      if (!q || typeof q.label !== 'string' || !q.label.trim()) continue;
      n += 1;
      const optional = q.required === false ? '（可选）' : '';
      lines.push(`**${n}. ${q.label.trim()}**${optional}`);
      lines.push(...renderOptions(q).filter(Boolean));
      lines.push('');
    }
    blocks.push(lines.join('\n').trimEnd());
  }

  // 这句是承重的：用户得知道「怎么回答」。飞书的「回复」是会话延续的唯一入口
  // （root_id 靠它保持稳定），直接新发一条会开一条新链、丢掉上下文。
  blocks.push('---\n*直接**回复本条消息**作答即可，无需打开 Greenhouse。*');
  return blocks.join('\n\n');
}
