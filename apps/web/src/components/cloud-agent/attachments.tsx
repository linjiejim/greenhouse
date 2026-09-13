/**
 * Mission-preset attachment staging.
 *
 * The picking rules and the chip row are shared with every other conversation
 * (`components/conversation/attachments.tsx`); this module only supplies the
 * mission uploader, which stages blobs under a user-scoped key prefix instead
 * of writing a `chat_files` row.
 *
 * That difference exists solely because `enqueueRun` still consumes storage
 * keys. It disappears with the `sprouty-mission` preset (convergence spec M2),
 * at which point missions read the same `chat_files` handles as everyone else.
 */

import {
  MAX_CLOUD_AGENT_ATTACHMENTS,
  MAX_CLOUD_AGENT_ATTACHMENT_BYTES,
  uploadCloudAgentAttachment,
  type CloudAgentAttachmentRef,
} from '../../lib/api/cloud-agent';
import { acceptAttachments, uploadPendingAttachments, type PendingAttachment } from '../conversation/attachments';

export type PendingCloudAttachment = PendingAttachment<CloudAgentAttachmentRef>;

export function acceptCloudAttachments(
  prev: PendingCloudAttachment[],
  incoming: File[],
): { next: PendingCloudAttachment[]; tooLarge: File[]; overflow: number } {
  return acceptAttachments(prev, incoming, {
    maxCount: MAX_CLOUD_AGENT_ATTACHMENTS,
    maxBytes: MAX_CLOUD_AGENT_ATTACHMENT_BYTES,
  });
}

export function uploadPendingCloudAttachments(
  attachments: PendingCloudAttachment[],
  setState: React.Dispatch<React.SetStateAction<PendingCloudAttachment[]>>,
): Promise<CloudAgentAttachmentRef[] | null> {
  return uploadPendingAttachments(attachments, setState, async (file) => {
    const { key, name } = await uploadCloudAgentAttachment(file);
    return { key, name };
  });
}

export { AttachmentChips } from '../conversation/attachments';
