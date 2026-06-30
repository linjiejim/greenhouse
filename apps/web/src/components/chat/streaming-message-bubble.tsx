/**
 * Streaming message bubble — shown while the assistant is generating a response.
 * Extracted from message.tsx.
 */

import React, { useState, useEffect, useRef } from 'react';
import { RichMarkdown } from '../rich-markdown';
import { ToolCallRenderer } from '../tool-call/index';
import { BodyArtifacts, partitionCalls } from '../tool-call/body-artifacts';
import { MessageSquare, ChevronDown } from '../../lib/icons';
import { SproutyAvatar } from '../sprouty/index.js';
import { ReasoningPanel } from './reasoning-panel';
import type { StreamingToolCall } from './pipeline-viewer';

interface StreamingMessageProps {
  text: string;
  reasoning: string;
  toolCalls: StreamingToolCall[];
  isStreaming: boolean;
}

/**
 * Smoothly reveals streamed text so it eases in character-by-character instead
 * of jumping in bursts as network chunks land (the "突突突" effect). On each
 * tick we advance the displayed text toward the target, revealing a slice
 * proportional to the backlog — large gaps catch up fast, the tail glides in.
 *
 * Driven by a ~30fps interval rather than requestAnimationFrame: the reveal
 * cadence stays steady even in background tabs (where rAF is paused), and on
 * stream end we snap to the full text. When the target diverges from what's
 * shown (session switch, regenerate) we snap too, never animating stale content.
 */
const REVEAL_INTERVAL_MS = 33; // ~30fps

function useSmoothStreamedText(target: string, enabled: boolean): string {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    // Not streaming: show the final text immediately, no animation.
    if (!enabled) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    const id = setInterval(() => {
      const tgt = targetRef.current;
      const cur = displayRef.current;

      if (tgt.length < cur.length || !tgt.startsWith(cur)) {
        // Divergent or shrunk (reset / regenerate) → snap, don't animate.
        displayRef.current = tgt;
        setDisplay(tgt);
      } else if (cur.length < tgt.length) {
        const remaining = tgt.length - cur.length;
        // Ease-out catch-up: reveal ~1/6 of the backlog per tick (min 2 chars).
        const step = Math.max(2, Math.ceil(remaining / 6));
        const next = tgt.slice(0, cur.length + step);
        displayRef.current = next;
        setDisplay(next);
      }
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, target]);

  return display;
}

export function StreamingMessageBubble({ text, reasoning, toolCalls, isStreaming }: StreamingMessageProps) {
  const [showReasoning, setShowReasoning] = useState(true);

  // Smoothly eased reveal of the streamed answer.
  const displayText = useSmoothStreamedText(text, isStreaming);
  const catchingUp = displayText.length < text.length;

  // Split tool calls into trace-block rows vs. body artifacts (eval cards, generated
  // images, page diffs, the ask_user form). ask_user submission is handled by the
  // completed bubble once streaming ends, so no submit handler is wired here.
  const { trace: traceCalls, artifacts: artifactCalls } = partitionCalls(
    toolCalls.map((tc) => ({ name: tc.name, input: tc.input, output: tc.output, status: tc.status })),
  );

  // Auto-collapse the "Thinking" panel once the answer starts streaming. This
  // matches the completed bubble's collapsed default, so the overlay → final
  // swap doesn't make the panel jump shut. Only fires on the first text token.
  const collapsedOnTextRef = React.useRef(false);
  useEffect(() => {
    if (text && !collapsedOnTextRef.current) {
      collapsedOnTextRef.current = true;
      setShowReasoning(false);
    }
  }, [text]);

  return (
    <div className="animate-fade-in space-y-2">
      <div className="max-w-[90%]">
        {/* Reasoning */}
        {reasoning && (
          <>
            <button
              onClick={() => setShowReasoning(!showReasoning)}
              className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-secondary mb-1.5 transition-colors"
            >
              <MessageSquare size={12} className={isStreaming && !text ? 'animate-pulse' : ''} />
              <span>Thinking{isStreaming && !text ? '...' : ''}</span>
              <ChevronDown size={11} className={`transition-transform ${showReasoning ? 'rotate-180' : ''}`} />
            </button>
            {showReasoning && <ReasoningPanel reasoning={reasoning} />}
          </>
        )}

        {/* Tool calls (trace block) */}
        {traceCalls.length > 0 && (
          <div className="my-2">
            <ToolCallRenderer calls={traceCalls} variant="full" defaultCollapsed />
          </div>
        )}

        {/* Body artifacts — eval cards, generated images, page diffs. `streaming: true`
            DEFERS the interactive ask_user form to the committed MessageBubble: this overlay
            is torn down + remounted when the turn ends, which would wipe any selection made
            mid-stream. So the form appears only once the answer has fully streamed in.
            Non-interactive artifacts still render here. */}
        {artifactCalls.length > 0 && <BodyArtifacts calls={artifactCalls} ctx={{ content: text, streaming: true }} />}

        {/* Content — flush, no bubble (matches completed message) */}
        {text && (
          <div className="relative">
            <RichMarkdown content={displayText} compact />
            {(isStreaming || catchingUp) && (
              <span className="inline-block animate-pulse-dot text-primary-500 ml-0.5">▊</span>
            )}
          </div>
        )}

        {/* Initial loading — Sprouty thinking */}
        {isStreaming && !text && !reasoning && toolCalls.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2">
            <SproutyAvatar state="thinking" size="sm" animate />
            <span className="text-xs text-fg-faint animate-pulse">Thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
}
