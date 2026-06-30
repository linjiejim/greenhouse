/**
 * Agent transport — backend-agnostic streaming for the chat UI.
 *
 * The cloud (NDJSON) path exposes the `AgentTransport` interface and folds
 * events through the shared `RuntimeEvent` reducer.
 */

export type { AgentTransport, RuntimeEvent, RuntimeStreamState, RuntimeToolCall, PiStartConfig } from './types';
export { emptyStreamState } from './types';
export { applyRuntimeEvent } from './runtime-event';
export { CloudAgentTransport } from './cloud-transport';
export type { CloudTransportConfig } from './cloud-transport';
