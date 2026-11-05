import { describe, expect, it } from 'vitest';
import {
  cleanFilename,
  displayTitleFor,
  hammingDistance,
  kindForType,
  mergeFacets,
  newAssetId,
  normalizeFacets,
  normalizeTags,
  objectKeys,
  searchColumnsFor,
} from '../model.js';
import { buildPrompt, parseAiReply } from '../ai.js';
import type { AssetRow, FacetRow } from '../schema.js';

const facet = (key: string, values: string[], multiple = true): FacetRow => ({
  key,
  label_en: key,
  label_zh: key,
  values: values.map((value) => ({ value, ...(value === 'basil' ? { zh: '罗勒' } : {}) })),
  multiple,
  sort_order: 0,
  created_at: '',
  updated_at: '',
});
const defs = [facet('plant', ['basil', 'mint']), facet('channel', ['amazon', 'shopify'], false)];

describe('asset model', () => {
  it('keys objects by content and accepts only images and videos', () => {
    expect(objectKeys.original('a'.repeat(64), 'mp4')).toBe(`assets/${'a'.repeat(64)}/original.mp4`);
    expect(kindForType('image/heic')).toBe('image');
    expect(kindForType('video/quicktime')).toBe('video');
    expect(kindForType('image/svg+xml')).toBeNull();
    expect(kindForType('text/html')).toBeNull();
  });

  it('measures dHash distance bit by bit', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });

  it('cleans tags and keeps facet values the vocabulary offers', () => {
    expect(normalizeTags([' Basil ', 'basil', '', 'x'.repeat(50)])).toEqual(['Basil', 'x'.repeat(40)]);
    expect(normalizeFacets({ plant: ['basil', 'rose'], channel: ['amazon', 'shopify'], ghost: ['x'] }, defs)).toEqual({
      plant: ['basil'],
      channel: ['amazon'],
    });
    expect(mergeFacets({ plant: ['basil'] }, { plant: ['mint'], channel: ['shopify'] }, defs)).toEqual({
      plant: ['basil', 'mint'],
      channel: ['shopify'],
    });
  });

  it('titles fall back from the member to the AI to the file name', () => {
    expect(displayTitleFor({ title: 'Mine', ai_title: 'AI', original_name: 'f.jpg' })).toBe('Mine');
    expect(displayTitleFor({ title: ' ', ai_title: 'AI', original_name: 'f.jpg' })).toBe('AI');
    expect(displayTitleFor({ title: null, ai_title: null, original_name: 'f.jpg' })).toBe('f.jpg');
    expect(cleanFilename('C:\\photos\\a\u0000b.JPG')).toBe('ab.JPG');
  });

  it('makes facet labels and file-name words searchable', () => {
    const cols = searchColumnsFor(
      {
        title: null,
        ai_title: null,
        tags: [],
        ai_tags: [],
        facets: { plant: ['basil'] },
        ai_facets: {},
        description: null,
        ai_caption: null,
        ai_text: null,
        original_name: 'IMG_2034-kitchen.jpg',
        source: null,
      },
      defs,
    );
    expect(cols.search_a).toContain('罗勒');
    expect(cols.search_c).toContain('kitchen');
  });

  it('mints sortable prefixed ids', () => {
    const a = newAssetId('ast');
    expect(a).toMatch(/^ast_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newAssetId('acl').startsWith('acl_')).toBe(true);
  });
});

describe('AI cataloguing', () => {
  const asset = {
    kind: 'image',
    original_name: 'basil.jpg',
    title: 'Kitchen shot',
    description: null,
    tags: ['kitchen'],
    facets: {},
  } as unknown as AssetRow;

  it('tells the model what is known, the vocabulary and the language', () => {
    const prompt = buildPrompt(asset, defs, 'zh');
    expect(prompt).toContain('Kitchen shot');
    expect(prompt).toContain('basil (罗勒)');
    expect(prompt).toContain('Simplified Chinese');
    expect(buildPrompt(asset, defs, 'en')).toContain('in English');
  });

  it('reads a reply defensively', () => {
    expect(
      parseAiReply(
        {
          title: ' 罗勒 ',
          caption: 3,
          tags: ['a', 1],
          text: '',
          facets: { plant: 'basil', ghost: ['x'] },
          people: 'no',
        },
        defs,
        'vision-model',
      ),
    ).toEqual({
      title: '罗勒',
      caption: null,
      tags: ['a'],
      text: null,
      facets: { plant: ['basil'] },
      people: null,
      model: 'vision-model',
    });
    expect(parseAiReply('not an object', defs, 'm')).toMatchObject({ title: null, tags: [], facets: {} });
  });
});
