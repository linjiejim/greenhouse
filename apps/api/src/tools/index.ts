/**
 * Tools index — register all agent tools.
 */

export { createAnalyzeImageTool } from './analyze-image.js';
export { createExternalSearchTool } from './external-search/index.js';
export { createFeatureRequestTool } from './feature-request.js';
export type { FeatureRequestContext } from './feature-request.js';
export { createGenerateImageTool } from './generate-image.js';
export { createProjectManagerTool } from './project-manager.js';
export type { ProjectManagerContext } from './project-manager.js';
export { createTeamKnowledgeTool } from './team-knowledge.js';
export { createPersonalKnowledgeTool } from './personal-knowledge.js';
export type { PersonalKnowledgeContext } from './personal-knowledge.js';
export { createProjectQueryTool } from './project-query.js';
export type { ProjectQueryContext } from './project-query.js';
export { createProjectMutationTool } from './project-mutation.js';
export type { ProjectMutationContext } from './project-mutation.js';
export { createSessionQueryTool } from './session-query.js';
export type { SessionQueryContext } from './session-query.js';
export { createSpawnSessionTool, MAX_SPAWN_DEPTH } from './spawn-session.js';
export type { SpawnSessionContext } from './spawn-session.js';
export { createCallLlmTool } from './call-llm.js';
export type { CallLlmContext } from './call-llm.js';
export { createKnowledgeQueryTool } from './knowledge-query.js';
export type { KnowledgeQueryContext } from './knowledge-query.js';
export { createKnowledgeMutationTool } from './knowledge-mutation.js';
export type { KnowledgeMutationContext } from './knowledge-mutation.js';

export { createAskUserTool } from './ask-user.js';
export { createComputeTool } from './compute/index.js';
export { createEmailManagerTool } from './email.js';
export type { EmailManagerContext } from './email.js';
export { createSessionHistoryTool } from './session-history.js';
export type { SessionHistoryContext } from './session-history.js';
