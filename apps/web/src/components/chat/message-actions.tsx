/**
 * MessageActions — context menu for assistant message results.
 *
 * Actions:
 * - Copy as MD / HTML / Text
 * - Quick translate (sends as a new chat turn for streaming)
 * - Regenerate response (with confirmation)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ConfirmDialog } from '../ui';
import { Copy, Globe, FileText, ClipboardList, RotateCcw, Maximize2, GitFork, MoreHorizontal } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { ExportPdfButton } from '../pdf-export';
import { useHoverFlyout } from '../../hooks/use-hover-flyout';

interface MessageActionsProps {
  /** Raw markdown content of the assistant message */
  content: string;
  /** Rendered HTML content (from Markdown component) */
  renderedHtml?: string;
  /** Callback: send a translate request as a new chat message */
  onTranslate?: (targetLang: 'en' | 'zh') => void;
  /** Callback to trigger regeneration (parent handles API call) */
  onRegenerate?: () => void;
  /** Whether the chat is currently streaming (disable actions) */
  isStreaming?: boolean;
  /** Open the message in the fullscreen reader. */
  onFullscreen?: () => void;
  /** Fork the conversation through this Agent reply. */
  onFork?: () => void;
  /** Disable repeat clicks while a fork request is running. */
  isForking?: boolean;
}

type CopyFormat = 'markdown' | 'html' | 'text';

export function MessageActions({
  content,
  renderedHtml,
  onTranslate,
  onRegenerate,
  isStreaming,
  onFullscreen,
  onFork,
  isForking = false,
}: MessageActionsProps) {
  const t = useT();
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const {
    open: showMoreMenu,
    setOpen: setShowMoreMenu,
    openNow: openMoreMenu,
    closeNow: closeMoreMenu,
    closeSoon: closeMoreMenuSoon,
  } = useHoverFlyout();
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Close either menu on an outside click.
  useEffect(() => {
    if (!showCopyMenu && !showMoreMenu) return;
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setShowCopyMenu(false);
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setShowMoreMenu, showCopyMenu, showMoreMenu]);

  // Clear copy feedback after 2s
  useEffect(() => {
    if (!copyFeedback) return;
    const t = setTimeout(() => setCopyFeedback(null), 2000);
    return () => clearTimeout(t);
  }, [copyFeedback]);

  const handleCopy = useCallback(
    async (format: CopyFormat) => {
      let textToCopy = '';
      switch (format) {
        case 'markdown':
          textToCopy = content;
          break;
        case 'html':
          textToCopy = renderedHtml || content;
          break;
        case 'text':
          textToCopy = markdownToPlainText(content);
          break;
      }
      try {
        if (format === 'html' && renderedHtml) {
          // Use ClipboardItem for rich HTML copy
          const blob = new Blob([renderedHtml], { type: 'text/html' });
          const textBlob = new Blob([markdownToPlainText(content)], { type: 'text/plain' });
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': blob,
              'text/plain': textBlob,
            }),
          ]);
        } else {
          await navigator.clipboard.writeText(textToCopy);
        }
        const labels: Record<CopyFormat, string> = { markdown: 'MD', html: 'HTML', text: 'Text' };
        setCopyFeedback(`${labels[format]} ✓`);
      } catch (_err) {
        setCopyFeedback('Failed');
      }
      setShowCopyMenu(false);
    },
    [content, renderedHtml],
  );

  const handleRegenerate = useCallback(() => {
    setShowRegenConfirm(true);
    setShowCopyMenu(false);
    setShowMoreMenu(false);
  }, [setShowMoreMenu]);

  const confirmRegenerate = useCallback(() => {
    setShowRegenConfirm(false);
    onRegenerate?.();
  }, [onRegenerate]);

  return (
    <div ref={actionsRef} className="relative inline-flex items-center gap-1">
      {/* Copy feedback toast */}
      {copyFeedback && <span className="text-[10px] text-success font-medium animate-fade-in">{copyFeedback}</span>}

      {/* Compact icon actions share one stable right-aligned row. */}
      <div className="flex items-center gap-0.5">
        <ExportPdfButton markdown={content} isStreaming={isStreaming} iconOnly />

        {/* Copy dropdown trigger */}
        <button
          onClick={() => {
            setShowCopyMenu((open) => !open);
            setShowMoreMenu(false);
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary"
          title={t('common.copy')}
          aria-label={t('common.copy')}
        >
          <Copy size={14} />
        </button>

        {/* Regenerate */}
        {onRegenerate && (
          <button
            onClick={handleRegenerate}
            disabled={isStreaming}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-warning-subtle hover:text-warning disabled:opacity-40"
            title={t('chat.regenerateResponse')}
            aria-label={t('chat.regenerateResponse')}
          >
            <RotateCcw size={14} />
          </button>
        )}

        {(onFullscreen || onFork || onTranslate) && (
          <div
            className="relative inline-flex"
            onMouseEnter={openMoreMenu}
            onMouseLeave={closeMoreMenuSoon}
            onFocusCapture={openMoreMenu}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMoreMenu();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeMoreMenu();
              }
            }}
          >
            <button
              onClick={() => {
                setShowMoreMenu(true);
                setShowCopyMenu(false);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary"
              title={t('common.more')}
              aria-label={t('common.more')}
              aria-haspopup="menu"
              aria-expanded={showMoreMenu}
            >
              <MoreHorizontal size={14} />
            </button>

            {showMoreMenu && (
              <div role="menu" className="absolute bottom-full right-0 z-20 min-w-[180px] pb-1 animate-fade-in">
                <div className="rounded-lg border border-edge bg-surface-raised py-1 shadow-lg">
                  {onFullscreen && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setShowMoreMenu(false);
                        onFullscreen();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-sunken"
                    >
                      <Maximize2 size={13} className="text-fg-faint" />
                      {t('chat.fullscreen')}
                    </button>
                  )}
                  {onFork && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setShowMoreMenu(false);
                        onFork();
                      }}
                      disabled={isStreaming || isForking}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-sunken disabled:opacity-40"
                    >
                      <GitFork size={13} className="text-fg-faint" />
                      {t('chat.forkFromReply')}
                    </button>
                  )}
                  {onTranslate && (
                    <>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onTranslate('en');
                        }}
                        disabled={isStreaming}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-sunken disabled:opacity-40"
                      >
                        <Globe size={13} className="text-fg-faint" />
                        {t('chat.translateToEnglish')}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onTranslate('zh');
                        }}
                        disabled={isStreaming}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-sunken disabled:opacity-40"
                      >
                        <Globe size={13} className="text-fg-faint" />
                        {t('messageActions.translateToChinese')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Copy format dropdown */}
      {showCopyMenu && (
        <div className="absolute bottom-full right-0 mb-1 bg-surface-raised border border-edge rounded-lg shadow-lg py-1 z-10 min-w-[140px] animate-fade-in">
          <button
            onClick={() => handleCopy('markdown')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <ClipboardList size={12} className="text-fg-faint" /> {t('messageActions.copyAsMd')}
          </button>
          <button
            onClick={() => handleCopy('html')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <Globe size={12} className="text-fg-faint" /> {t('messageActions.copyAsHtml')}
          </button>
          <button
            onClick={() => handleCopy('text')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <FileText size={12} className="text-fg-faint" /> {t('messageActions.copyAsText')}
          </button>
        </div>
      )}

      {/* Regenerate confirmation dialog */}
      <ConfirmDialog
        open={showRegenConfirm}
        onClose={() => setShowRegenConfirm(false)}
        onConfirm={confirmRegenerate}
        title={t('chat.regenerateConfirm')}
        description={t('chat.regenerateWarning')}
        confirmLabel={t('chat.regenerate')}
      />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Convert markdown to plain text by stripping formatting.
 */
function markdownToPlainText(md: string): string {
  return (
    md
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, (block) => {
        return block
          .replace(/```\w*\n?/g, '')
          .replace(/```/g, '')
          .trim();
      })
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove strikethrough
      .replace(/~~(.+?)~~/g, '$1')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, '')
      // Remove list markers
      .replace(/^[\s]*[-*+]\s+/gm, '• ')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      // Clean up extra whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
