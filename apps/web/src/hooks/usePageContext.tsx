/**
 * usePageContext — 便捷 Hook 用于在页面组件中声明 Agent 上下文
 *
 * 自动处理 mount/unmount 和依赖更新，消除各页面的 boilerplate。
 *
 * Usage:
 *   usePageContext(
 *     selectedPage ? { type: 'wiki-detail', slug: selectedPage.slug, title: selectedPage.title } : { type: 'wiki-list' },
 *     [selectedPage]
 *   );
 */

import { useEffect } from 'react';
import { useAgentContext } from '../components/agent-context';
import type { PageContext } from '@greenhouse/types/agent-context';

export function usePageContext(ctx: PageContext | null, deps: unknown[] = []): void {
  const { setPageContext } = useAgentContext();

  useEffect(() => {
    setPageContext(ctx);
    return () => setPageContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, setPageContext]);
}
