/**
 * @vitest-environment happy-dom
 *
 * The Bot look editor: fifteen static species chips + four moods. A pick writes
 * `plant` (+ its nearest legacy colour) or the mood as `faceStyle`, and never
 * drops the rest of the stored avatar.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import { I18nProvider } from '../../lib/i18n';
import { AvatarPicker } from './avatar-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(value: AvatarConfig, extra: { templateKey?: string | null; stableId?: string; animate?: boolean } = {}) {
  const onChange = vi.fn();
  act(() =>
    root.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(AvatarPicker, { value, onChange, ...extra }),
      }),
    ),
  );
  return onChange;
}

const chip = (plant: string) => host.querySelector<HTMLButtonElement>(`button[data-plant="${plant}"]`)!;
const moodChip = (mood: string) => host.querySelector<HTMLButtonElement>(`button[data-mood="${mood}"]`)!;

describe('<AvatarPicker/>', () => {
  it('offers all fifteen species as static, named chips', () => {
    mount({ plant: 'ivy' });
    const chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="plant-picker-species"] button')];
    expect(chips).toHaveLength(15);
    expect(chips.map((button) => button.getAttribute('aria-label'))).toContain('Prickly Pear');
    // A picker is a list: none of the chips animate.
    expect(host.querySelectorAll('[data-testid="plant-picker-species"] .pa-mo')).toHaveLength(0);
  });

  it('marks the selected species with a solid ring, the faint edge only on hover', () => {
    mount({ plant: 'ivy' });
    // WCAG 1.4.11: the selected chip's ring is its state indicator and must reach 3:1 on the
    // dialog. Dark's `primary-edge` is a 25% overlay (~1.35:1), so it is a hover cue only.
    const selected = chip('ivy').className.split(/\s+/);
    expect(selected).toEqual(expect.arrayContaining(['ring-2', 'ring-primary-500']));
    expect(selected).not.toContain('ring-primary-edge');
    const other = chip('fern').className.split(/\s+/);
    expect(other).not.toContain('ring-primary-500');
    expect(other.filter((name) => name.includes('primary-edge'))).toEqual(['hover:ring-primary-edge']);
  });

  it('plays the hero preview by default and holds it still when asked (in a transcript)', () => {
    const preview = () => host.querySelector('[data-testid="bots-avatar-picker"] > div > .pa-root')!;
    mount({ plant: 'ivy' });
    expect(preview().querySelector('.pa-mo')).not.toBeNull();
    mount({ plant: 'ivy' }, { animate: false });
    expect(preview().querySelector('svg')).not.toBeNull();
    expect(preview().querySelector('.pa-mo')).toBeNull();
  });

  it('marks the plant a legacy avatar resolves to, using the Bot template', () => {
    mount({ color: 'ocean', accessories: ['magnifier'] }, { templateKey: 'analyst', stableId: 'bot_1' });
    expect(chip('clover').getAttribute('aria-pressed')).toBe('true');
    expect(chip('echeveria').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-testid="bots-avatar-caption"]')!.textContent).toBe('Clover · Calm');
  });

  it('writes plant + nearest legacy colour and keeps every other key', () => {
    const onChange = mount({ color: 'forest', accessories: ['clipboard'], faceStyle: 'happy' });
    act(() => chip('lotus').click());
    expect(onChange).toHaveBeenCalledWith({
      color: 'blossom',
      accessories: ['clipboard'],
      faceStyle: 'happy',
      plant: 'lotus',
    });
  });

  it('writes the mood as faceStyle and drops a mood key that would override it', () => {
    const onChange = mount({ plant: 'fern', mood: 'drowsy' });
    expect(moodChip('drowsy').getAttribute('aria-pressed')).toBe('true');
    act(() => moodChip('soft').click());
    expect(onChange).toHaveBeenCalledWith({ plant: 'fern', faceStyle: 'happy' });
  });
});
