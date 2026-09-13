/**
 * Knowledge application registration.
 *
 * Knowledge already has a shared owner/editor/reader access resolver consumed
 * by HTTP and tools. During migration each adapter binds its existing operation
 * into this guarded handler, so capability authorization and platform audit
 * wrap the real operation without duplicating the domain ACL.
 */

import type { ApplicationRegistration } from '@greenhouse/platform-kernel';
import { knowledgeManifest } from '../manifests/knowledge.js';
import { runBoundPlatformOperation, type PlatformHandlerContext } from '../runtime.js';

export const knowledgeRegistration: ApplicationRegistration<PlatformHandlerContext> = {
  manifest: knowledgeManifest,
  handlers: {
    listDocuments: runBoundPlatformOperation,
    readDocument: runBoundPlatformOperation,
    searchDocuments: runBoundPlatformOperation,
    listVersions: runBoundPlatformOperation,
    createDocument: runBoundPlatformOperation,
    updateDocument: runBoundPlatformOperation,
    archiveDocument: runBoundPlatformOperation,
    restoreVersion: runBoundPlatformOperation,
    listShares: runBoundPlatformOperation,
    manageShares: runBoundPlatformOperation,
    generateDocument: runBoundPlatformOperation,
    rewriteDocument: runBoundPlatformOperation,
    enrichDocument: runBoundPlatformOperation,
  },
};
