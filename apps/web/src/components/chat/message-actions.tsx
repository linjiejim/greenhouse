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
import { Copy, Globe, FileText, ClipboardList, RotateCcw } from '../../lib/icons';
import { useT } from '../../lib/i18n';

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
}

type CopyFormat = 'markdown' | 'html' | 'text';

export function MessageActions({ content, renderedHtml, onTranslate, onRegenerate, isStreaming }: MessageActionsProps) {
  const t = useT();
  const [showMenu, setShowMenu] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

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
      setShowMenu(false);
    },
    [content, renderedHtml],
  );

  const handleRegenerate = useCallback(() => {
    setShowRegenConfirm(true);
    setShowMenu(false);
  }, []);

  const confirmRegenerate = useCallback(() => {
    setShowRegenConfirm(false);
    onRegenerate?.();
  }, [onRegenerate]);

  return (
    <div className="relative inline-flex items-center gap-1">
      {/* Copy feedback toast */}
      {copyFeedback && <span className="text-[10px] text-success font-medium animate-fade-in">{copyFeedback}</span>}

      {/* Quick action buttons (always visible on hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover/actions:opacity-100 transition-opacity">
        {/* Copy dropdown trigger */}
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="p-1 text-fg-faint hover:text-fg-secondary rounded hover:bg-surface-muted transition-colors"
          title="Copy"
        >
          <Copy size={14} />
        </button>

        {/* Translate buttons — sends as a new chat turn */}
        {onTranslate && (
          <>
            <button
              onClick={() => onTranslate('en')}
              disabled={isStreaming}
              className="px-1.5 py-0.5 text-[10px] text-fg-faint hover:text-info rounded hover:bg-info-subtle transition-colors disabled:opacity-40"
              title="Translate to English"
            >
              EN
            </button>
            <button
              onClick={() => onTranslate('zh')}
              disabled={isStreaming}
              className="px-1.5 py-0.5 text-[10px] text-fg-faint hover:text-info rounded hover:bg-info-subtle transition-colors disabled:opacity-40"
              title={t('messageActions.translateToChinese')}
            >
              {t('messageActions.zh')}
            </button>
          </>
        )}

        {/* Regenerate */}
        {onRegenerate && (
          <button
            onClick={handleRegenerate}
            disabled={isStreaming}
            className="p-1 text-fg-faint hover:text-warning rounded hover:bg-warning-subtle transition-colors disabled:opacity-40"
            title="Regenerate response"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>

      {/* Copy format dropdown */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute bottom-full right-0 mb-1 bg-surface-raised border border-edge rounded-lg shadow-lg py-1 z-10 min-w-[140px] animate-fade-in"
        >
          <button
            onClick={() => handleCopy('markdown')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <ClipboardList size={12} className="text-fg-faint" /> Copy as MD
          </button>
          <button
            onClick={() => handleCopy('html')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <Globe size={12} className="text-fg-faint" /> Copy as HTML
          </button>
          <button
            onClick={() => handleCopy('text')}
            className="w-full px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-sunken flex items-center gap-2"
          >
            <FileText size={12} className="text-fg-faint" /> Copy as Text
          </button>
        </div>
      )}

      {/* Regenerate confirmation dialog */}
      <ConfirmDialog
        open={showRegenConfirm}
        onClose={() => setShowRegenConfirm(false)}
        onConfirm={confirmRegenerate}
        title="Regenerate this response?"
        description="The current response will be replaced with a new one."
        confirmLabel="Regenerate"
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
