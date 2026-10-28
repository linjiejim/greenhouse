import { describe, it, expect } from 'vitest';
import { registerToolResultAdapters } from '@greenhouse/agent-core';
import { knowledgeTranscript } from '../transcript.js';
import { extractPipelineAndReferences } from '../../../../apps/api/src/agent-runtime/run-agent.js';
registerToolResultAdapters([knowledgeTranscript]);
function v6Step(toolName: string, input: unknown, output: unknown) {
  return {
    toolCalls: [{ toolCallId: 'call_1', toolName, input }],
    toolResults: [{ toolCallId: 'call_1', toolName, output }],
  };
}
describe('compact knowledge transcripts and citations', () => {
  it('still compacts whitelisted knowledge reads and extracts references', () => {
    const out = {
      scope: 'shared',
      id: 7,
      doc_id: 'onboarding-guide',
      url: '#/knowledge/doc/7-onboarding-guide',
      title: 'Onboarding guide',
      content: 'abc',
      folder: 'guides',
    };
    const { pipeline, references } = extractPipelineAndReferences([
      v6Step('knowledge_query', { action: 'get', doc_id: 'onboarding-guide' }, out),
    ]);

    expect(pipeline[0].output).toEqual({
      action: 'get',
      scope: 'shared',
      doc_id: 'onboarding-guide',
      title: 'Onboarding guide',
      chars: 3,
    });
    expect(references).toEqual([
      {
        slug: 'onboarding-guide',
        title: 'Onboarding guide',
        type: 'kb_doc',
        url: '#/knowledge/doc/7-onboarding-guide',
        category: 'guides',
      },
    ]);
  });
  it('compacts a knowledge_query document read instead of storing the whole body', () => {
    const body = 'x'.repeat(5000);
    const { pipeline } = extractPipelineAndReferences([
      v6Step(
        'knowledge_query',
        { action: 'get', scope: 'team', doc_id: 'guide/chat' },
        { scope: 'team', id: 7, doc_id: 'guide/chat', title: 'Chat 进阶', content: body, tags: [] },
      ),
    ]);

    expect(pipeline[0].output).toEqual({
      action: 'get',
      scope: 'team',
      doc_id: 'guide/chat',
      title: 'Chat 进阶',
      chars: 5000,
    });
    expect(JSON.stringify(pipeline[0].output)).not.toContain(body);
  });
  it('summarizes a knowledge_query folder listing to its size, not the tree', () => {
    const { pipeline } = extractPipelineAndReferences([
      v6Step(
        'knowledge_query',
        { action: 'folders', scope: 'team' },
        {
          scope: 'team',
          root: '/',
          folders: [{ id: 1, path: '指南', depth: 1, docs: 3 }],
          total_folders: 1,
        },
      ),
    ]);
    expect(pipeline[0].output).toEqual({ action: 'folders', scope: 'team', root: '/', folders: 1 });
  });
  it('summarizes a knowledge_query search by shape, keeping the weak-match flag', () => {
    const { pipeline } = extractPipelineAndReferences([
      v6Step(
        'knowledge_query',
        { action: 'search', scope: 'team', query: '规格' },
        { scope: 'team', found: 2, weak_match: true, results: [{ id: 1 }, { id: 2 }] },
      ),
    ]);

    // weak_match must survive: it is the honesty signal about that answer.
    expect(pipeline[0].output).toEqual({ action: 'search', scope: 'team', found: 2, weak_match: true });
  });
  it('summarizes a knowledge_query tree browse without the per-folder document lists', () => {
    const { pipeline } = extractPipelineAndReferences([
      v6Step(
        'knowledge_query',
        { action: 'tree', scope: 'team' },
        { scope: 'team', root: '/', total_docs: 12, folders: [{ path: '指南', docs: [{ id: 1, title: 'a' }] }] },
      ),
    ]);

    expect(pipeline[0].output).toEqual({ action: 'tree', scope: 'team', root: '/', docs: 12 });
  });
});
