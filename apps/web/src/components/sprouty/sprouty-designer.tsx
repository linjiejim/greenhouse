/**
 * SproutyDesigner — the "sculpt your Sprouty" editor (脸萌-style).
 *
 * One shared implementation of the avatar DSL editor: live preview, color
 * presets + free palette (body/leaf hex), face style, accessories (mutually
 * exclusive per slot), leaf style, and an agent-state preview strip.
 * Used by the custom-profile editor (member personalization) and the
 * Branding Studio team-avatar section (workspace default).
 */

import React, { useState } from 'react';
import {
  SproutyFace,
  COLOR_PRESETS,
  ACCESSORIES,
  LEAF_STYLES,
  FACE_STYLES,
  type LeafStyle,
  type FaceStyle,
  type SproutyPalette,
} from './index.js';
import { useT } from '../../lib/i18n';

export interface SproutyDesignValue {
  color: string;
  accessories: string[];
  leafStyle: LeafStyle;
  faceStyle?: FaceStyle;
  palette?: SproutyPalette;
}

export const DEFAULT_SPROUTY_DESIGN: SproutyDesignValue = {
  color: 'forest',
  accessories: [],
  leafStyle: 'normal',
};

type PreviewState = 'idle' | 'thinking' | 'responding' | 'done' | 'error';
const PREVIEW_STATES: PreviewState[] = ['idle', 'thinking', 'responding', 'done', 'error'];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[10px] font-medium text-fg-faint uppercase tracking-wider block mb-1.5 text-center">
      {children}
    </label>
  );
}

export function SproutyDesigner({
  value,
  onChange,
  showStatePreview = true,
}: {
  value: SproutyDesignValue;
  onChange: (next: SproutyDesignValue) => void;
  showStatePreview?: boolean;
}) {
  const t = useT();
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const customActive = !!value.palette;

  const enableCustomPalette = () => {
    const preset = COLOR_PRESETS[value.color] ?? COLOR_PRESETS.forest;
    onChange({ ...value, palette: { body: preset.body, leaf: preset.leaf } });
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4 bg-surface-sunken rounded-xl">
      <SproutyFace
        variant="custom"
        color={value.color}
        accessories={value.accessories}
        leafStyle={value.leafStyle}
        faceStyle={value.faceStyle}
        palette={value.palette}
        state={previewState}
        size="xl"
        animate
      />

      {/* Color: presets + free palette */}
      <div className="w-full">
        <FieldLabel>{t('sproutyDesigner.color')}</FieldLabel>
        <div className="flex items-center gap-2 flex-wrap justify-center">
          {Object.entries(COLOR_PRESETS).map(([key, colors]) => (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ ...value, color: key, palette: undefined })}
              title={key.charAt(0).toUpperCase() + key.slice(1)}
              className={`w-6 h-6 rounded-full border-2 transition-all ${
                !customActive && value.color === key
                  ? 'border-fg-secondary scale-110 ring-2 ring-primary-300/40'
                  : 'border-transparent hover:border-edge-strong hover:scale-105'
              }`}
              style={{ backgroundColor: colors.body }}
            />
          ))}
          <button
            type="button"
            onClick={() => (customActive ? onChange({ ...value, palette: undefined }) : enableCustomPalette())}
            title={t('sproutyDesigner.customColor')}
            className={`h-6 px-2 rounded-full border text-[10px] transition-all ${
              customActive
                ? 'border-primary-500 bg-primary-subtle text-primary-fg font-medium'
                : 'border-edge text-fg-faint hover:border-edge-strong'
            }`}
          >
            🎨 {t('sproutyDesigner.customColor')}
          </button>
        </div>
        {customActive && (
          <div className="flex items-center justify-center gap-4 mt-2">
            <label className="flex items-center gap-1.5 text-[10px] text-fg-muted">
              {t('sproutyDesigner.bodyColor')}
              <input
                type="color"
                value={value.palette?.body ?? '#a4d65e'}
                onChange={(e) => onChange({ ...value, palette: { ...value.palette, body: e.target.value } })}
                className="h-6 w-8 rounded border border-edge cursor-pointer"
                aria-label={t('sproutyDesigner.bodyColor')}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-fg-muted">
              {t('sproutyDesigner.leafColor')}
              <input
                type="color"
                value={value.palette?.leaf ?? '#6abf4b'}
                onChange={(e) => onChange({ ...value, palette: { ...value.palette, leaf: e.target.value } })}
                className="h-6 w-8 rounded border border-edge cursor-pointer"
                aria-label={t('sproutyDesigner.leafColor')}
              />
            </label>
          </div>
        )}
      </div>

      {/* Face style */}
      <div className="w-full">
        <FieldLabel>{t('sproutyDesigner.faceStyle')}</FieldLabel>
        <div className="flex items-center gap-1.5 flex-wrap justify-center">
          {FACE_STYLES.map((fs) => (
            <button
              key={fs.id}
              type="button"
              onClick={() => onChange({ ...value, faceStyle: fs.id === 'default' ? undefined : fs.id })}
              title={fs.name}
              className={`px-2 py-1 rounded-md flex items-center gap-1 text-xs transition-colors ${
                (value.faceStyle ?? 'default') === fs.id
                  ? 'bg-primary-subtle text-primary-fg ring-1 ring-primary-edge'
                  : 'hover:bg-surface-muted text-fg-faint'
              }`}
            >
              <span>{fs.emoji}</span>
              <span className="text-[10px]">{fs.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Accessories (mutually exclusive per slot) */}
      <div className="w-full">
        <FieldLabel>{t('sproutyDesigner.accessories')}</FieldLabel>
        {(['hat', 'glasses', 'held'] as const).map((type) => {
          const items = ACCESSORIES.filter((a) => a.type === type);
          return (
            <div key={type} className="mb-1.5">
              <span className="text-[9px] text-fg-faint block mb-1 text-center">
                {t(`sproutyDesigner.slot_${type}`)}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap justify-center">
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...value,
                      accessories: value.accessories.filter((a) => !items.some((it) => it.id === a)),
                    })
                  }
                  className={`w-7 h-7 rounded-md flex items-center justify-center text-[10px] transition-colors ${
                    !items.some((it) => value.accessories.includes(it.id))
                      ? 'bg-primary-subtle text-primary-fg ring-1 ring-primary-edge'
                      : 'hover:bg-surface-muted text-fg-faint'
                  }`}
                  title={t('sproutyDesigner.none')}
                >
                  ✕
                </button>
                {items.map((acc) => {
                  const selected = value.accessories.includes(acc.id);
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => {
                        const others = value.accessories.filter((a) => !items.some((it) => it.id === a));
                        onChange({ ...value, accessories: selected ? others : [...others, acc.id] });
                      }}
                      title={acc.name}
                      className={`w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors ${
                        selected ? 'bg-primary-subtle ring-1 ring-primary-edge' : 'hover:bg-surface-muted'
                      }`}
                    >
                      {acc.emoji}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Leaf style */}
      <div className="w-full">
        <FieldLabel>{t('sproutyDesigner.leafStyle')}</FieldLabel>
        <div className="flex items-center gap-1.5 flex-wrap justify-center">
          {LEAF_STYLES.map((ls) => (
            <button
              key={ls.id}
              type="button"
              onClick={() => onChange({ ...value, leafStyle: ls.id })}
              title={ls.name}
              className={`px-2 py-1 rounded-md flex items-center gap-1 text-xs transition-colors ${
                value.leafStyle === ls.id
                  ? 'bg-primary-subtle text-primary-fg ring-1 ring-primary-edge'
                  : 'hover:bg-surface-muted text-fg-faint'
              }`}
            >
              <span>{ls.emoji}</span>
              <span className="text-[10px]">{ls.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Agent-state preview strip */}
      {showStatePreview && (
        <div className="flex items-center gap-1">
          {PREVIEW_STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setPreviewState(s)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                previewState === s ? 'bg-primary-subtle text-primary-fg' : 'text-fg-faint hover:bg-surface-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
