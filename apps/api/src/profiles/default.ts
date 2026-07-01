/**
 * Default Agent Profile — public / external assistant.
 * The fallback profile, used automatically when no profile is specified.
 */

import { defineProfile, readPrompt } from './define.js';

export default defineProfile({
  id: 'default',
  name: 'Greenhouse Assistant',
  version: '2026-06-30',
  description:
    'A helpful, knowledgeable general-purpose assistant for public/external users — answers questions grounded in the knowledge base.',

  // Access: public-facing, stateless-friendly, no rich-output guide.
  access: { level: 'public', requires_session: false, rich_output: false },

  // Model: pinned (no choices) — registry id `flash`, thinking on.
  model: { id: 'flash', provider: 'openai-compatible', model: 'flash', options: { thinking: true } },

  tools: ['knowledge_query', 'analyze_image', 'ask_user'],

  system_prompt: readPrompt(import.meta.dirname, 'default.prompt.md'),

  capabilities: [
    { icon: 'Search', label: 'Search the knowledge base', prompt: 'Search for ' },
    { icon: 'HelpCircle', label: 'Ask a question', prompt: 'How do I ' },
    { icon: 'Image', label: 'Analyze an image', prompt: 'Please analyze this image and tell me what you see.' },
  ],

  max_steps: 12,
  tool_choice: 'auto',
});
