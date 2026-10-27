import type { MessageActions } from './messages';
export function ReplyAvatar() {
  return null;
}
export function ReplyActions(_props: { text: string; actions?: MessageActions; live: boolean }) {
  return null;
}

export { toolActivity as replySummary } from './tool-words';
export function useMessageLayout() {
  return { userText: {}, authorName: {}, showAgentName: false };
}
