/**
 * Tools index — register all agent tools.
 */

export { createAnalyzeImageTool } from './media/analyze-image.js';
export { createExternalSearchTool } from './external-search/index.js';
export { createFeatureRequestTool } from './interaction/feature-request.js';
export type { FeatureRequestContext } from './interaction/feature-request.js';
export { createGenerateImageTool } from './media/generate-image.js';
export { createProjectManagerTool } from './projects/project-manager.js';
export type { ProjectManagerContext } from './projects/project-manager.js';
export { createProjectQueryTool } from './projects/project-query.js';
export type { ProjectQueryContext } from './projects/project-query.js';
export { createProjectMutationTool } from './projects/project-mutation.js';
export type { ProjectMutationContext } from './projects/project-mutation.js';
export { createSessionQueryTool } from './sessions/session-query.js';
export type { SessionQueryContext } from './sessions/session-query.js';
export { createSpawnSessionTool, MAX_SPAWN_DEPTH } from './sessions/spawn-session.js';
export type { SpawnSessionContext } from './sessions/spawn-session.js';
export { createCallLlmTool } from './sessions/call-llm.js';
export type { CallLlmContext } from './sessions/call-llm.js';
export { createKnowledgeQueryTool } from './knowledge/knowledge-query.js';
export type { KnowledgeQueryContext } from './knowledge/knowledge-query.js';
export { createKnowledgeMutationTool } from './knowledge/knowledge-mutation.js';
export type { KnowledgeMutationContext } from './knowledge/knowledge-mutation.js';

export { createAskUserTool } from './interaction/ask-user.js';
export { createComputeTool } from './compute/index.js';
export { createEmailManagerTool } from './email/index.js';
export type { EmailManagerContext } from './email/index.js';
export { createSessionHistoryTool } from './sessions/session-history.js';
export type { SessionHistoryContext } from './sessions/session-history.js';
