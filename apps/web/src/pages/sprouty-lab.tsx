import React, { useEffect, useMemo, useState } from 'react';
import {
  SproutyAvatar,
  SproutyGeometricMark,
  SPROUTY_GEOMETRIC_CONCEPTS,
  ACCESSORIES,
  COLOR_PRESETS,
  EYE_STYLES,
  LEAF_STYLES,
} from '../components/sprouty';
import type { EyeStyle, LeafStyle, SproutySize, SproutyState } from '../components/sprouty';
import { Button, Checkbox, Select, toast } from '../components/ui';
import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  ClipboardList,
  Coffee,
  Copy,
  Crown,
  Droplets,
  Glasses,
  GraduationCap,
  HardHat,
  HatGlasses,
  Headphones,
  Pencil,
  RotateCcw,
  Search,
  Wrench,
} from '../lib/icons';
import type { LucideIcon } from '../lib/icons';
import { safeParse } from '../lib/utils';

const STORAGE_KEY = 'greenhouse_sprouty_lab';
const STATES: SproutyState[] = ['idle', 'thinking', 'responding', 'done', 'error'];
const SIZES: SproutySize[] = ['xs', 'sm', 'md', 'lg', 'xl'];
const ACCESSORY_ICONS: Record<string, LucideIcon> = {
  crown: Crown,
  cap: HardHat,
  graduation: GraduationCap,
  headset: Headphones,
  'round-glasses': Glasses,
  sunglasses: HatGlasses,
  coffee: Coffee,
  wrench: Wrench,
  magnifier: Search,
  pencil: Pencil,
  clipboard: ClipboardList,
  chart: BarChart3,
  'watering-can': Droplets,
  book: BookOpen,
  briefcase: BriefcaseBusiness,
};

interface LabConfig {
  color: string;
  accessories: string[];
  leafStyle: LeafStyle;
  eyeStyle: EyeStyle;
  state: SproutyState;
  animate: boolean;
}

const DEFAULT_CONFIG: LabConfig = {
  color: 'forest',
  accessories: [],
  leafStyle: 'normal',
  eyeStyle: 'classic',
  state: 'idle',
  animate: true,
};

function loadConfig(): LabConfig {
  const saved = safeParse<Partial<LabConfig>>(localStorage.getItem(STORAGE_KEY), {});
  return {
    color: saved.color && COLOR_PRESETS[saved.color] ? saved.color : DEFAULT_CONFIG.color,
    accessories: Array.isArray(saved.accessories)
      ? saved.accessories.filter((id) => ACCESSORIES.some((item) => item.id === id))
      : [],
    leafStyle: LEAF_STYLES.some((item) => item.id === saved.leafStyle)
      ? (saved.leafStyle as LeafStyle)
      : DEFAULT_CONFIG.leafStyle,
    eyeStyle: EYE_STYLES.some((item) => item.id === saved.eyeStyle)
      ? (saved.eyeStyle as EyeStyle)
      : DEFAULT_CONFIG.eyeStyle,
    state: STATES.includes(saved.state as SproutyState) ? (saved.state as SproutyState) : DEFAULT_CONFIG.state,
    animate: saved.animate ?? DEFAULT_CONFIG.animate,
  };
}

export function SproutyLabPage() {
  const [config, setConfig] = useState<LabConfig>(loadConfig);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const profileJson = useMemo(
    () =>
      JSON.stringify(
        {
          color: config.color,
          accessories: config.accessories,
          leafStyle: config.leafStyle,
          eyeStyle: config.eyeStyle,
        },
        null,
        2,
      ),
    [config.accessories, config.color, config.eyeStyle, config.leafStyle],
  );

  const chooseAccessory = (id: string, type: 'hat' | 'glasses' | 'held') => {
    setConfig((current) => {
      const sameType = ACCESSORIES.filter((item) => item.type === type).map((item) => item.id);
      const others = current.accessories.filter((item) => !sameType.includes(item));
      return {
        ...current,
        accessories: current.accessories.includes(id) ? others : [...others, id],
      };
    });
  };

  const copyProfileJson = async () => {
    try {
      await navigator.clipboard.writeText(profileJson);
      toast('Profile avatar JSON copied.', 'success');
    } catch {
      toast('Could not copy the profile JSON.', 'error');
    }
  };

  return (
    <main className="min-h-screen bg-surface-sunken">
      <header className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface-raised px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Sprouty Avatar Lab</h1>
          <p className="text-xs text-fg-muted">
            The original rounded-sprouty.html was never tracked; this lab renders the production canvas directly.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfig(DEFAULT_CONFIG)}>
          <RotateCcw size={14} className="mr-1.5" />
          Reset
        </Button>
        <Button size="sm" onClick={copyProfileJson}>
          <Copy size={14} className="mr-1.5" />
          Copy profile JSON
        </Button>
      </header>

      <div className="grid min-h-[calc(100vh-4.5rem)] lg:grid-cols-[20rem_minmax(24rem,1fr)_20rem]">
        <aside className="space-y-5 border-b border-edge bg-surface-raised p-4 lg:border-b-0 lg:border-r">
          <ControlSection title="Profile appearance" description="Same persisted fields used by custom Agent profiles.">
            <div>
              <ControlLabel>Color</ControlLabel>
              <div className="flex flex-wrap gap-2">
                {Object.entries(COLOR_PRESETS).map(([id, palette]) => (
                  <Button
                    key={id}
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={id}
                    aria-label={`Use ${id} palette`}
                    aria-pressed={config.color === id}
                    onClick={() => setConfig((current) => ({ ...current, color: id }))}
                    className={`h-9 w-9 rounded-full p-1 ${
                      config.color === id ? 'ring-2 ring-primary-500 ring-offset-2 ring-offset-surface-raised' : ''
                    }`}
                  >
                    <span className="h-full w-full rounded-full" style={{ backgroundColor: palette.body }} />
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <ControlLabel>Leaf style</ControlLabel>
              <div className="grid grid-cols-2 gap-2">
                {LEAF_STYLES.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={config.leafStyle === item.id ? 'secondary' : 'outline'}
                    size="sm"
                    aria-pressed={config.leafStyle === item.id}
                    onClick={() => setConfig((current) => ({ ...current, leafStyle: item.id }))}
                    className="justify-start"
                  >
                    <SproutyAvatar
                      color={config.color}
                      accessories={config.accessories}
                      leafStyle={item.id}
                      state="idle"
                      size="xs"
                      animate={false}
                    />
                    <span className="ml-2">{item.name}</span>
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <ControlLabel>Eye style</ControlLabel>
              <div className="grid grid-cols-2 gap-2">
                {EYE_STYLES.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={config.eyeStyle === item.id ? 'secondary' : 'outline'}
                    size="sm"
                    aria-pressed={config.eyeStyle === item.id}
                    onClick={() => setConfig((current) => ({ ...current, eyeStyle: item.id }))}
                    className="h-auto min-w-0 justify-start px-2 py-1.5"
                    title={item.description}
                  >
                    <SproutyAvatar
                      color={config.color}
                      leafStyle={config.leafStyle}
                      eyeStyle={item.id}
                      state="idle"
                      size="sm"
                      animate={false}
                    />
                    <span className="ml-2 truncate">{item.name}</span>
                  </Button>
                ))}
              </div>
            </div>

            {(['hat', 'glasses', 'held'] as const).map((type) => (
              <div key={type}>
                <ControlLabel>{type === 'held' ? 'Held item' : type}</ControlLabel>
                <div className="grid grid-cols-2 gap-2">
                  {ACCESSORIES.filter((item) => item.type === type).map((item) => {
                    const selected = config.accessories.includes(item.id);
                    const AccessoryIcon = ACCESSORY_ICONS[item.id];
                    return (
                      <Button
                        key={item.id}
                        type="button"
                        variant={selected ? 'secondary' : 'outline'}
                        size="sm"
                        aria-pressed={selected}
                        onClick={() => chooseAccessory(item.id, type)}
                        className="min-w-0 justify-start px-2"
                        title={item.name}
                      >
                        <AccessoryIcon size={16} className="shrink-0 text-primary-400" />
                        <span className="ml-2 truncate">{item.name}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </ControlSection>
        </aside>

        <section className="flex min-h-[32rem] flex-col items-center justify-center gap-8 overflow-hidden p-6">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              State
              <Select
                size="sm"
                inline
                value={config.state}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, state: event.target.value as SproutyState }))
                }
              >
                {STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </Select>
            </label>
            <Checkbox
              label="Animate"
              checked={config.animate}
              onChange={(event) => setConfig((current) => ({ ...current, animate: event.target.checked }))}
            />
          </div>

          <div className="flex h-72 w-72 items-center justify-center rounded-[4rem] border border-edge bg-surface-raised shadow-xl shadow-primary-900/10">
            <div className="flex h-60 w-60 items-center justify-center">
              <SproutyAvatar
                variant="custom"
                color={config.color}
                accessories={config.accessories}
                leafStyle={config.leafStyle}
                eyeStyle={config.eyeStyle}
                state={config.state}
                size="xl"
                animate={config.animate}
                className="scale-200"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-center gap-5 rounded-xl border border-edge bg-surface-raised px-5 py-4">
            {SIZES.map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <SproutyAvatar
                  variant="custom"
                  color={config.color}
                  accessories={config.accessories}
                  leafStyle={config.leafStyle}
                  eyeStyle={config.eyeStyle}
                  state={config.state}
                  size={size}
                  animate={config.animate}
                />
                <span className="text-[10px] text-fg-faint">{size}</span>
              </div>
            ))}
          </div>

          <section className="w-full max-w-5xl space-y-3">
            <div className="text-center">
              <div className="text-sm font-semibold text-fg">Geometric plant DNA explorations</div>
              <p className="mt-1 text-xs text-fg-muted">
                Non-production concepts using the selected palette. Each mark is shown at display, 32px, and 24px sizes.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {SPROUTY_GEOMETRIC_CONCEPTS.map((concept) => (
                <article
                  key={concept.id}
                  className={`flex min-w-0 flex-col rounded-xl border bg-surface-raised p-3 ${
                    concept.recommended ? 'border-primary-500 ring-1 ring-primary-500/30' : 'border-edge'
                  }`}
                >
                  <div className="flex min-h-32 items-center justify-center rounded-lg bg-surface-sunken">
                    <SproutyGeometricMark concept={concept.id} color={config.color} size={104} />
                  </div>
                  <div className="mt-3 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="text-sm font-semibold text-fg">{concept.name}</h3>
                        {concept.recommended && (
                          <span className="rounded-full bg-primary-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-fg-strong">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[10px] font-medium text-primary-400">{concept.role}</p>
                    </div>
                    <div className="flex shrink-0 items-end gap-1">
                      <SproutyGeometricMark concept={concept.id} color={config.color} size={32} />
                      <SproutyGeometricMark concept={concept.id} color={config.color} size={24} />
                    </div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-fg-muted">{concept.description}</p>
                </article>
              ))}
            </div>
          </section>
        </section>

        <aside className="space-y-5 border-t border-edge bg-surface-raised p-4 lg:border-l lg:border-t-0">
          <ControlSection
            title="Profile payload"
            description="Paste this object into the avatar field of a custom profile."
          >
            <pre className="overflow-x-auto rounded-lg border border-edge bg-surface-sunken p-3 text-xs text-fg-secondary">
              {profileJson}
            </pre>
          </ControlSection>

          <ControlSection title="Review notes">
            <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-fg-muted">
              <li>The silhouette stays readable at 24px, but held items become visual noise below 48px.</li>
              <li>
                Several palettes have similar perceived contrast; grayscale and dark-surface checks should guide
                revisions.
              </li>
              <li>
                Eye style is a Profile baseline; emotional states still override it when status needs to read clearly.
              </li>
              <li>
                Recommended additions now available: Watering Can for Greenhouse, Open Book for knowledge, and Briefcase
                for work.
              </li>
            </ul>
          </ControlSection>
        </aside>
      </div>
    </main>
  );
}

function ControlSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold capitalize text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-fg-faint">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ControlLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">{children}</div>;
}
