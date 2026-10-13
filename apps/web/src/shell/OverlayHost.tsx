import { NewAgentDrawer } from '../pages/agents/NewAgentDrawer';
import { NewRoomDialog } from '../pages/conversation/NewRoomDialog';
import type { OverlayRequest } from './overlays';

/** Renders the one drawer or dialog a page asked for. */
export function OverlayHost({ request, onClose }: { request: OverlayRequest; onClose: () => void }) {
  switch (request.type) {
    case 'new-agent':
      return <NewAgentDrawer prefill={request.prefill} onClose={onClose} />;
    case 'new-room':
      return <NewRoomDialog onClose={onClose} />;
    case 'custom':
      return <>{request.render(onClose)}</>;
  }
}
