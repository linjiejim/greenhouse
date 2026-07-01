/**
 * Team Agent Profile — internal team assistant.
 * Web research, writing, and knowledge-base retrieval over shared / team /
 * personal knowledge. Tools assembled dynamically by user permission document
 * their own usage rules in their tool description — not restated here.
 */

import { defineProfile, readPrompt } from './define.js';

export default defineProfile({
  id: 'team',
  name: 'Team Assistant',
  version: '2026-06-30',
  description:
    'Internal team assistant — deep research, writing, knowledge-base retrieval, and team/personal knowledge management.',

  access: { level: 'internal', requires_session: false, rich_output: true },

  // Model: switchable between Fast (`flash`) and Deep (`pro`).
  model: {
    id: 'flash',
    provider: 'openai-compatible',
    model: 'flash',
    options: { thinking: true, temperature: 0.4, max_tokens: 20000 },
    choices: [
      { id: 'flash', label: 'Fast' },
      { id: 'pro', label: 'Deep' },
    ],
  },

  tools: [
    'knowledge_query',
    'analyze_image',
    'external_search',
    'feature_request',
    'generate_image',
    'project_manager',
    'team_knowledge',
    'personal_knowledge',
  ],

  system_prompt: readPrompt(import.meta.dirname, 'team.prompt.md'),

  capabilities: [
    { icon: 'Globe', label: 'Deep web research', prompt: 'Research ' },
    { icon: 'FileEdit', label: 'Write an article', prompt: 'Write an article about ' },
    { icon: 'Search', label: 'Search the knowledge base', prompt: 'Search the knowledge base for ' },
    { icon: 'Image', label: 'Analyze an image', prompt: 'Analyze this image' },
    { icon: 'BarChart3', label: 'Competitive & market analysis', prompt: 'Analyze the competitive landscape for ' },
  ],

  max_steps: 30,
  tool_choice: 'auto',
});
