/**
 * Compatibility barrel for existing Web renderers. The platform-free Rich
 * Output protocol and parser live in @greenhouse/types so native clients share the
 * exact same validation and streaming semantics.
 */
export * from '@greenhouse/types/rich-output';
