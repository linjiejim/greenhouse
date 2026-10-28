/** Load the agent catalog after extension activation; channel imports must not initialize it. */
export async function channelAgentRuntime() {
  const agent = await import('../agent.js');
  const resolution = await import('./tool-resolution.js');
  return {
    buildSystemPrompt: agent.buildSystemPrompt,
    selectTools: agent.selectTools,
    resolveEffectiveTools: resolution.resolveEffectiveTools,
    buildLazyServerTools: resolution.buildLazyServerTools,
    LAZY_TOOL_IDS: resolution.LAZY_TOOL_IDS,
  };
}
export async function runAgentTurn(...args: Parameters<typeof import('./run-agent.js').runAgentInSession>) {
  const { runAgentInSession } = await import('./run-agent.js');
  return runAgentInSession(...args);
}
