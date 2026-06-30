/**
 * Internal Design System Showcase
 *
 * A lightweight Storybook alternative for previewing and testing
 * all shared UI components. Access via #/design (hidden from nav).
 *
 * Each section is stateless — interactive controls are local to the demo.
 */

import React, { useState } from 'react';
import {
  Button,
  Badge,
  Tag,
  TagList,
  Card,
  Input,
  Select,
  Textarea,
  Tabs,
  Dialog,
  ConfirmDialog,
  Drawer,
  Pagination,
  Spinner,
  StarRating,
  Skeleton,
  SkeletonRow,
  SkeletonCard,
  EmptyState,
  ListToolbar,
  AppLogo,
  ErrorBoundary,
  SearchInput,
  Toggle,
  StatusDot,
  Checkbox,
  Avatar,
  DateRangeInput,
  toast,
} from '../components/ui';
import { DetailHeader, DetailSection, FieldGrid, Field } from '../components/detail';
import { Markdown } from '../components/markdown';
import { RichMarkdown } from '../components/rich-markdown';
import { DataTableBlock } from '../components/blocks/datatable-block';
import { ChartBlock } from '../components/blocks/chart-block';
import { ConfirmBlock } from '../components/blocks/confirm-block';
import type { ChartData, DataTableData } from '../components/blocks/index';
import {
  Search,
  Mail,
  Plus,
  Settings,
  Trash2,
  Download,
  Eye,
  Star,
  Check,
  AlertTriangle,
  Info,
  HelpCircle,
  Copy,
  ChevronRight,
  Pencil,
  RefreshCw,
} from '../lib/icons';

// ─── Section Wrapper ─────────────────────────────────────

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-lg font-semibold text-fg mb-1 pb-2 border-b border-edge">{title}</h2>
      {description && <p className="text-xs text-fg-muted mb-4 -mt-1">{description}</p>}
      <div className="space-y-6 mt-4">{children}</div>
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-fg-secondary mb-3">{title}</h3>
      {children}
    </div>
  );
}

function DemoRow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>;
}

function CodeLabel({ children }: { children: React.ReactNode }) {
  return <code className="text-[11px] font-mono bg-surface-muted text-fg-muted px-1.5 py-0.5 rounded">{children}</code>;
}

/** Collapsible code snippet viewer */
function CodeSnippet({ code, label = 'Show Code' }: { code: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg-secondary transition-colors"
      >
        <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
      </button>
      {open && (
        <pre className="mt-1.5 p-3 bg-surface-sunken rounded-md text-[11px] font-mono text-fg-secondary overflow-x-auto border border-edge">
          {code}
        </pre>
      )}
    </div>
  );
}

// ─── Color Token Preview ─────────────────────────────────

function ColorSwatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={`w-12 h-12 rounded-lg border border-edge shadow-sm ${className}`} />
      <span className="text-[10px] font-mono text-fg-muted text-center leading-tight">{name}</span>
    </div>
  );
}

// ─── Nav Sidebar ─────────────────────────────────────────

const NAV_SECTIONS = [
  {
    group: 'Foundations',
    items: [
      { id: 'colors', label: 'Colors' },
      { id: 'typography', label: 'Typography' },
      { id: 'spacing', label: 'Spacing & Radius' },
      { id: 'animations', label: 'Animations' },
    ],
  },
  {
    group: 'Primitives',
    items: [
      { id: 'buttons', label: 'Buttons' },
      { id: 'badges', label: 'Badges' },
      { id: 'tag', label: 'Tag / TagList' },
      { id: 'inputs', label: 'Form Inputs' },
      { id: 'search-input', label: 'SearchInput' },
      { id: 'checkbox', label: 'Checkbox' },
      { id: 'toggle', label: 'Toggle' },
      { id: 'date-range', label: 'DateRangeInput' },
      { id: 'cards', label: 'Cards' },
      { id: 'tabs', label: 'Tabs' },
      { id: 'avatar', label: 'Avatar' },
      { id: 'status-dot', label: 'StatusDot' },
    ],
  },
  {
    group: 'Overlays',
    items: [
      { id: 'dialogs', label: 'Dialogs' },
      { id: 'drawers', label: 'Drawers' },
      { id: 'feedback', label: 'Feedback' },
    ],
  },
  {
    group: 'Data Display',
    items: [
      { id: 'skeletons', label: 'Skeletons' },
      { id: 'list-toolbar', label: 'ListToolbar' },
      { id: 'empty-states', label: 'Empty States' },
      { id: 'star-rating', label: 'Star Rating' },
      { id: 'datatable', label: 'DataTable' },
      { id: 'pagination', label: 'Pagination' },
      { id: 'chart', label: 'Chart' },
      { id: 'confirm-block', label: 'Confirm Block' },
    ],
  },
  {
    group: 'Detail',
    items: [{ id: 'detail-kit', label: 'Detail Kit' }],
  },
  {
    group: 'Content',
    items: [
      { id: 'markdown', label: 'Markdown' },
      { id: 'rich-markdown', label: 'Rich Markdown' },
      { id: 'error-boundary', label: 'Error Boundary' },
      { id: 'logo', label: 'Logo' },
    ],
  },
];

// ─── Main Page ───────────────────────────────────────────

export function DesignPage() {
  const [activeSection, setActiveSection] = useState('colors');

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar nav */}
      <nav className="hidden md:flex flex-col w-48 flex-shrink-0 border-r border-edge bg-surface-raised overflow-y-auto py-3 px-2">
        <div className="px-2 mb-3">
          <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Design System</span>
        </div>
        {NAV_SECTIONS.map((group) => (
          <div key={group.group} className="mb-3">
            <div className="px-2 mb-1">
              <span className="text-[10px] font-medium text-fg-faint uppercase tracking-wider">{group.group}</span>
            </div>
            {group.items.map((s) => (
              <a
                key={s.id}
                href={`#/design#${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  setActiveSection(s.id);
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' });
                }}
                className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors ${
                  activeSection === s.id
                    ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                    : 'text-fg-muted hover:text-fg hover:bg-surface-muted'
                }`}
              >
                {s.label}
              </a>
            ))}
          </div>
        ))}
      </nav>

      {/* Mobile tab bar */}
      <div className="md:hidden fixed top-12 left-0 right-0 z-10 bg-surface-raised border-b border-edge overflow-x-auto scrollbar-hide px-2 py-1.5 flex gap-1">
        {NAV_SECTIONS.flatMap((g) => g.items).map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setActiveSection(s.id);
              document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' });
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs rounded-md transition-colors ${
              activeSection === s.id
                ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-12">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-fg mb-1">Component Library</h1>
          <p className="text-sm text-fg-muted">
            Internal design system reference — all shared components from <CodeLabel>components/ui.tsx</CodeLabel>,{' '}
            <CodeLabel>components/blocks/</CodeLabel>, and <CodeLabel>components/markdown.tsx</CodeLabel>.
          </p>
        </div>

        {/* Foundations */}
        <ColorsSection />
        <TypographySection />
        <SpacingSection />
        <AnimationsSection />

        {/* Primitives */}
        <ButtonsSection />
        <BadgesSection />
        <TagSection />
        <InputsSection />
        <SearchInputSection />
        <CheckboxSection />
        <ToggleSection />
        <DateRangeSection />
        <CardsSection />
        <TabsSection />
        <AvatarSection />
        <StatusDotSection />

        {/* Overlays */}
        <DialogsSection />
        <DrawersSection />
        <FeedbackSection />

        {/* Data Display */}
        <SkeletonsSection />
        <ListToolbarSection />
        <EmptyStatesSection />
        <StarRatingSection />
        <DataTableSection />
        <PaginationSection />
        <ChartSection />
        <ConfirmBlockSection />

        {/* Detail */}
        <DetailKitSection />

        {/* Content */}
        <MarkdownSection />
        <RichMarkdownSection />
        <ErrorBoundarySection />
        <LogoSection />

        {/* Footer spacer */}
        <div className="h-16" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// FOUNDATIONS
// ═══════════════════════════════════════════════════════════

function ColorsSection() {
  return (
    <Section
      id="colors"
      title="Color Tokens"
      description="Semantic color system — auto-adapts to light/dark themes via CSS variables."
    >
      <SubSection title="Surfaces">
        <DemoRow>
          <ColorSwatch name="surface" className="bg-surface" />
          <ColorSwatch name="raised" className="bg-surface-raised" />
          <ColorSwatch name="muted" className="bg-surface-muted" />
          <ColorSwatch name="sunken" className="bg-surface-sunken" />
        </DemoRow>
      </SubSection>

      <SubSection title="Foreground (Text)">
        <div className="space-y-2 bg-surface-raised rounded-lg p-4 border border-edge">
          <p className="text-fg text-sm font-medium">text-fg — Primary text</p>
          <p className="text-fg-secondary text-sm">text-fg-secondary — Body text</p>
          <p className="text-fg-muted text-sm">text-fg-muted — Labels, captions</p>
          <p className="text-fg-faint text-sm">text-fg-faint — Hints, placeholders</p>
        </div>
        <CodeSnippet
          code={`<p className="text-fg">Primary</p>
<p className="text-fg-secondary">Body</p>
<p className="text-fg-muted">Label</p>
<p className="text-fg-faint">Hint</p>

❌ Never use: text-gray-*, text-black, text-white`}
        />
      </SubSection>

      <SubSection title="Borders">
        <DemoRow>
          <div className="w-24 h-12 rounded-lg border border-edge flex items-center justify-center text-[10px] text-fg-muted font-mono">
            edge
          </div>
          <div className="w-24 h-12 rounded-lg border-2 border-edge-strong flex items-center justify-center text-[10px] text-fg-muted font-mono">
            edge-strong
          </div>
        </DemoRow>
      </SubSection>

      <SubSection title="Primary Palette">
        <DemoRow>
          {[50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((shade) => (
            <ColorSwatch key={shade} name={`${shade}`} className={`bg-primary-${shade}`} />
          ))}
        </DemoRow>
        <p className="text-[10px] text-fg-faint mt-2">Driven by active theme (Teal, Forest, Ocean, etc.)</p>
      </SubSection>

      <SubSection title="Status Colors">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg p-3 bg-success-subtle border border-success">
            <span className="text-xs font-medium text-success">Success</span>
          </div>
          <div className="rounded-lg p-3 bg-warning-subtle border border-warning">
            <span className="text-xs font-medium text-warning">Warning</span>
          </div>
          <div className="rounded-lg p-3 bg-danger-subtle border border-danger">
            <span className="text-xs font-medium text-danger">Danger</span>
          </div>
          <div className="rounded-lg p-3 bg-info-subtle border border-info">
            <span className="text-xs font-medium text-info">Info</span>
          </div>
        </div>
      </SubSection>

      <SubSection title="Primary Semantic">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="rounded-lg p-3 bg-primary-subtle border border-primary-edge">
            <span className="text-xs font-medium text-primary-fg-strong">primary-subtle</span>
          </div>
          <div className="rounded-lg p-3 bg-primary-subtle-hover border border-primary-edge">
            <span className="text-xs font-medium text-primary-fg">primary-subtle-hover</span>
          </div>
        </div>
      </SubSection>
    </Section>
  );
}

function TypographySection() {
  return (
    <Section id="typography" title="Typography" description="Font scale and weight conventions used across the app.">
      <div className="space-y-3 bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex items-baseline gap-3">
          <CodeLabel>text-lg</CodeLabel>
          <span className="text-lg font-semibold text-fg">Heading Large — page titles</span>
        </div>
        <div className="flex items-baseline gap-3">
          <CodeLabel>text-base</CodeLabel>
          <span className="text-base font-semibold text-fg">Heading Base — section titles</span>
        </div>
        <div className="flex items-baseline gap-3">
          <CodeLabel>text-sm</CodeLabel>
          <span className="text-sm text-fg-secondary">Body text — the default for most content</span>
        </div>
        <div className="flex items-baseline gap-3">
          <CodeLabel>text-xs</CodeLabel>
          <span className="text-xs text-fg-muted">Labels, tags, secondary info</span>
        </div>
        <div className="flex items-baseline gap-3">
          <CodeLabel>text-[10px]</CodeLabel>
          <span className="text-[10px] text-fg-faint">Timestamps, fine print</span>
        </div>
      </div>

      <SubSection title="Font Weights">
        <div className="space-y-1 bg-surface-raised rounded-lg p-4 border border-edge">
          <p className="text-sm font-normal text-fg">font-normal (400) — body text</p>
          <p className="text-sm font-medium text-fg">font-medium (500) — labels, table headers</p>
          <p className="text-sm font-semibold text-fg">font-semibold (600) — headings, emphasis</p>
          <p className="text-sm font-bold text-fg">font-bold (700) — page titles</p>
        </div>
      </SubSection>

      <SubSection title="Truncation Pattern">
        <div className="bg-surface-raised rounded-lg p-4 border border-edge max-w-xs">
          <p
            className="truncate text-sm text-fg"
            title="This is a very long text that should be truncated with an ellipsis when it overflows the container width"
          >
            This is a very long text that should be truncated with an ellipsis when it overflows the container width
          </p>
          <p className="text-[10px] text-fg-faint mt-2">
            Rule: always pair <CodeLabel>truncate</CodeLabel> with <CodeLabel>title=&#123;value&#125;</CodeLabel>
          </p>
        </div>
      </SubSection>
    </Section>
  );
}

function SpacingSection() {
  return (
    <Section
      id="spacing"
      title="Spacing & Radius"
      description="Standard spacing tokens, border radius scale, and z-index layers."
    >
      <SubSection title="Border Radius">
        <DemoRow>
          {[
            { label: 'rounded-md', cls: 'rounded-md', usage: 'buttons, inputs' },
            { label: 'rounded-lg', cls: 'rounded-lg', usage: 'cards, panels' },
            { label: 'rounded-xl', cls: 'rounded-xl', usage: 'dialogs, modals' },
            { label: 'rounded-full', cls: 'rounded-full', usage: 'badges, avatars' },
          ].map((r) => (
            <div key={r.label} className="flex flex-col items-center gap-2">
              <div className={`w-16 h-16 bg-primary-200 border border-primary-400 ${r.cls}`} />
              <CodeLabel>{r.label}</CodeLabel>
              <span className="text-[10px] text-fg-faint">{r.usage}</span>
            </div>
          ))}
        </DemoRow>
      </SubSection>

      <SubSection title="Standard Spacing">
        <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-1">
          <p className="text-sm text-fg-secondary">
            <CodeLabel>gap-2</CodeLabel> — flex items spacing
          </p>
          <p className="text-sm text-fg-secondary">
            <CodeLabel>p-3</CodeLabel> — card padding
          </p>
          <p className="text-sm text-fg-secondary">
            <CodeLabel>px-3 md:px-4</CodeLabel> — section horizontal padding
          </p>
          <p className="text-sm text-fg-secondary">
            <CodeLabel>mb-4</CodeLabel> — section margin bottom
          </p>
        </div>
      </SubSection>

      <SubSection title="Z-Index Layers">
        <div className="bg-surface-raised rounded-lg p-4 border border-edge">
          <div className="space-y-1.5">
            {[
              { z: 'z-10', label: 'Sticky headers' },
              { z: 'z-20', label: 'Dropdowns, popovers' },
              { z: 'z-40', label: 'Backdrops' },
              { z: 'z-50', label: 'Modals / Dialogs / Drawers' },
              { z: 'z-[60]', label: 'Nested modals' },
              { z: 'z-[100]', label: 'Toast notifications' },
            ].map((item) => (
              <div key={item.z} className="flex items-center gap-3">
                <CodeLabel>{item.z}</CodeLabel>
                <span className="text-sm text-fg-secondary">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </SubSection>
    </Section>
  );
}

function AnimationsSection() {
  const [showAnim, setShowAnim] = useState<string | null>(null);
  const [animKey, setAnimKey] = useState(0);

  return (
    <Section
      id="animations"
      title="Animations"
      description="CSS animations defined in app.css for transitions and feedback."
    >
      <SubSection title="Entrance Animations">
        <DemoRow>
          {['animate-fade-in', 'animate-slide-up', 'animate-slide-in-left', 'animate-slide-in-right'].map((anim) => (
            <Button
              key={anim}
              variant="outline"
              size="sm"
              onClick={() => {
                setShowAnim(anim);
                setAnimKey((k) => k + 1);
              }}
            >
              {anim.replace('animate-', '')}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setShowAnim(null)}>
            Reset
          </Button>
        </DemoRow>

        {showAnim && (
          <Card key={`${showAnim}-${animKey}`} className={`p-4 max-w-sm mt-3 ${showAnim}`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-100 flex items-center justify-center">
                <ChevronRight size={16} className="text-primary-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-fg">{showAnim}</p>
                <p className="text-xs text-fg-muted">Click button again to replay</p>
              </div>
            </div>
          </Card>
        )}
      </SubSection>

      <SubSection title="Continuous Animations">
        <DemoRow>
          <div className="flex items-center gap-3">
            <Spinner className="h-5 w-5 text-primary-500" />
            <span className="text-sm text-fg-muted">animate-spin</span>
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-20" />
            <span className="text-sm text-fg-muted">animate-skeleton</span>
          </div>
        </DemoRow>
      </SubSection>
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════
// PRIMITIVES
// ═══════════════════════════════════════════════════════════

function ButtonsSection() {
  return (
    <Section
      id="buttons"
      title="Button"
      description="components/ui.tsx — primary action component. Use instead of raw <button>."
    >
      <SubSection title="Variants">
        <DemoRow>
          <Button variant="default">Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
        </DemoRow>
        <CodeSnippet
          code={`<Button variant="default">Default</Button>
<Button variant="destructive">Delete</Button>`}
        />
      </SubSection>

      <SubSection title="Sizes">
        <DemoRow>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button size="icon">
            <Plus size={16} />
          </Button>
        </DemoRow>
      </SubSection>

      <SubSection title="With Icons">
        <DemoRow>
          <Button size="sm">
            <Plus size={12} className="mr-1.5" />
            Add Item
          </Button>
          <Button variant="outline" size="sm">
            <Download size={12} className="mr-1.5" />
            Export
          </Button>
          <Button variant="ghost" size="sm">
            <Settings size={14} className="mr-1.5" />
            Settings
          </Button>
          <Button variant="destructive" size="sm">
            <Trash2 size={12} className="mr-1.5" />
            Delete
          </Button>
        </DemoRow>
        <CodeSnippet
          code={`<Button size="sm">
  <Plus size={12} className="mr-1.5" />
  Add Item
</Button>`}
        />
      </SubSection>

      <SubSection title="States">
        <DemoRow>
          <Button disabled>Disabled</Button>
          <Button variant="outline" disabled>
            Disabled Outline
          </Button>
          <Button>
            <Spinner className="mr-2" />
            Loading…
          </Button>
        </DemoRow>
      </SubSection>
    </Section>
  );
}

function BadgesSection() {
  return (
    <Section id="badges" title="Badge" description="components/ui.tsx — status labels, tags, version badges.">
      <SubSection title="Variants">
        <DemoRow>
          <Badge variant="default">Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </DemoRow>
        <CodeSnippet
          code={`<Badge variant="success">Active</Badge>
<Badge variant="warning">Pending</Badge>`}
        />
      </SubSection>

      <SubSection title="Usage Examples">
        <DemoRow>
          <Badge variant="success">Active</Badge>
          <Badge variant="warning">Pending</Badge>
          <Badge variant="destructive">Error</Badge>
          <Badge variant="secondary">Draft</Badge>
          <Badge variant="default">v2.1.0</Badge>
        </DemoRow>
      </SubSection>
    </Section>
  );
}

function TagSection() {
  const colors = ['Red', 'Green', 'Blue', 'Yellow', 'Purple', 'Cyan', 'Magenta'];
  return (
    <Section
      id="tag"
      title="Tag / TagList"
      description="components/ui.tsx — single-line tags for table cells & dense metadata. Always whitespace-nowrap; pass truncate inside constrained cells. Never wraps char-by-char."
    >
      <SubSection title="Tones">
        <DemoRow>
          <Tag tone="neutral">Neutral</Tag>
          <Tag tone="primary">Primary</Tag>
          <Tag tone="success">Success</Tag>
          <Tag tone="warning">Warning</Tag>
          <Tag tone="danger">Danger</Tag>
          <Tag tone="info">Info</Tag>
        </DemoRow>
        <CodeSnippet code={`<Tag tone="success">Resolved</Tag>`} />
      </SubSection>

      <SubSection title="Truncate in a narrow cell (no wrap)">
        <div className="w-24 border border-dashed border-edge p-1">
          <Tag tone="info" truncate maxW="max-w-[100px]">
            已补发-配件超长内容
          </Tag>
        </div>
        <CodeSnippet code={`<Tag tone="info" truncate maxW="max-w-[100px]">{value}</Tag>`} />
      </SubSection>

      <SubSection title="TagList — first N + overflow count (single line)">
        <div className="w-48 border border-dashed border-edge p-1">
          <TagList items={colors} max={3} />
        </div>
        <CodeSnippet code={`<TagList items={tags} max={3} />`} />
      </SubSection>
    </Section>
  );
}

function PaginationSection() {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  return (
    <Section
      id="pagination"
      title="Pagination"
      description="components/ui.tsx — unified list footer: range text + page-size selector (20/50/100) + prev/next + jump-to-page. Pair with usePersistedPageSize. page is 0-based."
    >
      <SubSection title="Interactive">
        <div className="border border-edge rounded-lg overflow-hidden">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={4677}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        </div>
        <CodeSnippet
          code={`const [pageSize, setPageSize] = usePersistedPageSize('dashboard.inquiries', 20);
<Pagination page={page} pageSize={pageSize} total={total}
  onPageChange={setPage} onPageSizeChange={setPageSize} />`}
        />
      </SubSection>
    </Section>
  );
}

function DetailKitSection() {
  return (
    <Section
      id="detail-kit"
      title="Detail Kit"
      description="components/detail/ — shared primitives for record detail (view) & edit screens. Flat layout, label-above fields, status badges single-line."
    >
      <div className="border border-edge rounded-lg p-4 space-y-6">
        <DetailHeader
          icon={
            <div className="w-12 h-12 rounded-xl bg-surface-muted flex items-center justify-center flex-shrink-0">
              <Mail size={22} className="text-fg-muted" />
            </div>
          }
          titlePrefix={<span className="text-xs font-mono text-fg-muted">C-1024</span>}
          title="Acme Robotics"
          subtitle={
            <>
              <span className="text-sm text-fg-secondary">acme.example.com</span>
              <Tag tone="warning">Active</Tag>
              <Tag tone="info">Wholesale</Tag>
            </>
          }
          badges={[<Badge key="a">priority</Badge>, <Badge key="b">eu</Badge>]}
          actions={
            <Button size="sm" variant="outline">
              <Pencil size={12} className="mr-1" /> Edit
            </Button>
          }
        />
        <DetailSection title="Details">
          <FieldGrid cols={3}>
            <Field label="Quote Level" value="A" />
            <Field label="Phone" value="+1 555 0100" />
            <Field label="Country" value="Germany" />
            <Field label="Website" value={null} hideEmpty />
            <Field label="Notes" value="Long-form note spanning the full row." span="full" />
          </FieldGrid>
        </DetailSection>
      </div>
      <CodeSnippet
        code={`<DetailHeader icon={...} title={name} subtitle={...} badges={...} actions={<EditButton/>} />
<DetailSection title="Details">
  <FieldGrid cols={3}>
    <Field label="Phone" value={phone} hideEmpty />
  </FieldGrid>
</DetailSection>`}
      />
    </Section>
  );
}

function InputsSection() {
  return (
    <Section
      id="inputs"
      title="Form Inputs"
      description="components/ui.tsx — Input, Select, Textarea. Use instead of raw HTML elements."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <SubSection title="Input">
          <div className="space-y-3">
            <Input placeholder="Default input" />
            <Input placeholder="Disabled input" disabled />
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
              <Input placeholder="Search..." className="pl-9" />
            </div>
          </div>
          <CodeSnippet
            code={`<Input placeholder="Name" />

// With search icon
<div className="relative">
  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
  <Input placeholder="Search..." className="pl-9" />
</div>`}
          />
        </SubSection>

        <SubSection title="Select">
          <div className="space-y-3">
            <Select>
              <option value="">Choose an option…</option>
              <option value="1">Option One</option>
              <option value="2">Option Two</option>
              <option value="3">Option Three</option>
            </Select>
            <Select disabled>
              <option>Disabled select</option>
            </Select>
          </div>
        </SubSection>

        <SubSection title="Textarea">
          <div className="space-y-3">
            <Textarea placeholder="Write something…" rows={3} />
            <Textarea placeholder="Disabled textarea" rows={2} disabled />
          </div>
        </SubSection>

        <SubSection title="Form Layout Example">
          <Card className="p-4 space-y-3">
            <div>
              <label className="text-xs font-medium text-fg-secondary mb-1 block">Name</label>
              <Input placeholder="Enter name" />
            </div>
            <div>
              <label className="text-xs font-medium text-fg-secondary mb-1 block">Category</label>
              <Select>
                <option value="">Select category</option>
                <option value="a">Category A</option>
                <option value="b">Category B</option>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-fg-secondary mb-1 block">Description</label>
              <Textarea placeholder="Describe…" rows={2} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
              <Button size="sm">Save</Button>
            </div>
          </Card>
        </SubSection>
      </div>
    </Section>
  );
}

function CardsSection() {
  return (
    <Section
      id="cards"
      title="Card"
      description="components/ui.tsx — container with bg-surface-raised + border-edge + shadow-sm."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-fg mb-1">Basic Card</h3>
          <p className="text-xs text-fg-muted">Simple card with default styling.</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
              <Star size={14} className="text-primary-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-fg">With Icon</h3>
              <span className="text-[10px] text-fg-faint">Subtitle text</span>
            </div>
          </div>
          <p className="text-xs text-fg-muted">Card with avatar/icon header pattern.</p>
        </Card>
        <Card className="p-4 flex flex-col justify-between">
          <div>
            <Badge variant="success" className="mb-2">
              Active
            </Badge>
            <h3 className="text-sm font-semibold text-fg mb-1">Status Card</h3>
            <p className="text-xs text-fg-muted">With badge and action footer.</p>
          </div>
          <div className="mt-3 pt-3 border-t border-edge flex justify-end">
            <Button size="sm" variant="ghost">
              <Eye size={12} className="mr-1" />
              View
            </Button>
          </div>
        </Card>
      </div>
      <CodeSnippet
        code={`<Card className="p-4">
  <h3 className="text-sm font-semibold text-fg mb-1">Title</h3>
  <p className="text-xs text-fg-muted">Content</p>
</Card>`}
      />
    </Section>
  );
}

function TabsSection() {
  const [tab, setTab] = useState('overview');

  return (
    <Section id="tabs" title="Tabs" description="components/ui.tsx — pill-style tab bar for switching views.">
      <SubSection title="Basic">
        <Tabs
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'details', label: 'Details' },
            { key: 'history', label: 'History' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <Card className="mt-3 p-4">
          <p className="text-sm text-fg-secondary">
            Active tab: <CodeLabel>{tab}</CodeLabel>
          </p>
        </Card>
      </SubSection>

      <SubSection title="With Counts">
        <Tabs
          tabs={[
            { key: 'all', label: 'All', count: 128 },
            { key: 'active', label: 'Active', count: 42 },
            { key: 'archived', label: 'Archived', count: 86 },
          ]}
          active="all"
          onChange={() => {}}
        />
      </SubSection>
      <CodeSnippet
        code={`<Tabs
  tabs={[
    { key: 'all', label: 'All', count: 128 },
    { key: 'active', label: 'Active', count: 42 },
  ]}
  active={tab}
  onChange={setTab}
/>`}
      />
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════
// OVERLAYS
// ═══════════════════════════════════════════════════════════

function DialogsSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogSize, setDialogSize] = useState<'sm' | 'md' | 'lg' | 'xl'>('md');

  return (
    <Section
      id="dialogs"
      title="Dialog & ConfirmDialog"
      description="components/ui.tsx — modal overlays. Use instead of hand-rolled fixed inset-0."
    >
      <SubSection title="Standard Dialog">
        <DemoRow>
          {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <Button
              key={size}
              variant="outline"
              size="sm"
              onClick={() => {
                setDialogSize(size);
                setDialogOpen(true);
              }}
            >
              Size: {size}
            </Button>
          ))}
        </DemoRow>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title={`Dialog (${dialogSize})`}
          size={dialogSize}
        >
          <div className="space-y-4">
            <p className="text-sm text-fg-secondary">
              Dialog with size <CodeLabel>{dialogSize}</CodeLabel>. Escape or backdrop click to close.
            </p>
            <div>
              <label className="text-xs font-medium text-fg-secondary mb-1 block">Example Input</label>
              <Input placeholder="Type here…" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => setDialogOpen(false)}>
                Confirm
              </Button>
            </div>
          </div>
        </Dialog>
      </SubSection>

      <SubSection title="Confirm Dialog">
        <DemoRow>
          <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 size={12} className="mr-1.5" />
            Delete Item
          </Button>
        </DemoRow>
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            toast('Deleted!', 'success');
            setConfirmOpen(false);
          }}
          title="Are you sure?"
          description="This action cannot be undone."
          confirmLabel="Delete"
          confirmVariant="destructive"
        />
        <CodeSnippet
          code={`<ConfirmDialog
  open={open}
  onClose={() => setOpen(false)}
  onConfirm={handleDelete}
  title="Are you sure?"
  description="This action cannot be undone."
  confirmLabel="Delete"
  confirmVariant="destructive"
/>`}
        />
      </SubSection>
    </Section>
  );
}

function DrawersSection() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  return (
    <Section
      id="drawers"
      title="Drawer"
      description="components/ui.tsx — slide-in panel for detail views, forms, and navigation."
    >
      <DemoRow>
        <Button variant="outline" size="sm" onClick={() => setLeftOpen(true)}>
          Left Drawer (default)
        </Button>
        <Button variant="outline" size="sm" onClick={() => setRightOpen(true)}>
          Right Drawer (320px)
        </Button>
      </DemoRow>

      <Drawer open={leftOpen} onClose={() => setLeftOpen(false)} side="left">
        <div className="p-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-fg">Left Drawer</h3>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-fg-secondary">Default width (w-64). Slides from left.</p>
          <Button size="sm" variant="ghost" onClick={() => setLeftOpen(false)}>
            Close
          </Button>
        </div>
      </Drawer>

      <Drawer open={rightOpen} onClose={() => setRightOpen(false)} side="right" width={320}>
        <div className="p-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-fg">Right Drawer</h3>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-fg-secondary">Custom width (320px). Slides from right.</p>
          <div>
            <label className="text-xs font-medium text-fg-secondary mb-1 block">Quick Edit</label>
            <Input placeholder="Edit something…" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRightOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                toast('Saved!', 'success');
                setRightOpen(false);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </Drawer>

      <CodeSnippet
        code={`<Drawer open={open} onClose={() => setOpen(false)} side="right" width={320}>
  <div className="p-4">...</div>
</Drawer>`}
      />
    </Section>
  );
}

function FeedbackSection() {
  return (
    <Section
      id="feedback"
      title="Feedback"
      description="components/ui.tsx — toast() for notifications, Spinner for loading."
    >
      <SubSection title="Toast Notifications">
        <DemoRow>
          <Button size="sm" variant="outline" onClick={() => toast('Information message', 'info')}>
            <Info size={12} className="mr-1.5" />
            Info
          </Button>
          <Button size="sm" variant="outline" onClick={() => toast('Operation successful!', 'success')}>
            <Check size={12} className="mr-1.5" />
            Success
          </Button>
          <Button size="sm" variant="outline" onClick={() => toast('Please check your input', 'warning')}>
            <AlertTriangle size={12} className="mr-1.5" />
            Warning
          </Button>
          <Button size="sm" variant="outline" onClick={() => toast('Something went wrong', 'error')}>
            <Trash2 size={12} className="mr-1.5" />
            Error
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast('Item deleted', 'info', { onUndo: () => toast('Undone!', 'success') })}
          >
            With Undo
          </Button>
        </DemoRow>
        <CodeSnippet
          code={`toast('Saved!', 'success');
toast('Item deleted', 'info', {
  onUndo: () => toast('Undone!', 'success'),
  duration: 5000,
});`}
        />
      </SubSection>

      <SubSection title="Spinner">
        <DemoRow>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-fg-secondary">Default (h-4 w-4)</span>
          </div>
          <div className="flex items-center gap-2">
            <Spinner className="h-6 w-6 text-primary-500" />
            <span className="text-sm text-fg-secondary">Large + colored</span>
          </div>
          <div className="flex items-center gap-2">
            <Spinner className="h-3 w-3 text-fg-faint" />
            <span className="text-sm text-fg-secondary">Small + faint</span>
          </div>
        </DemoRow>
      </SubSection>
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════
// DATA DISPLAY
// ═══════════════════════════════════════════════════════════

function SkeletonsSection() {
  return (
    <Section
      id="skeletons"
      title="Skeletons"
      description="components/ui.tsx — loading placeholders. Use for layout-aware loading states."
    >
      <SubSection title="Basic Skeleton">
        <div className="space-y-2 max-w-sm">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <CodeSnippet code={`<Skeleton className="h-4 w-3/4" />`} />
      </SubSection>

      <SubSection title="Skeleton Card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </SubSection>

      <SubSection title="Skeleton Table Rows">
        <Card>
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge">
                <th className="px-3 py-2 text-left text-xs font-medium text-fg-muted">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-fg-muted">Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-fg-muted">Created</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-fg-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              <SkeletonRow cols={4} />
              <SkeletonRow cols={4} />
              <SkeletonRow cols={4} />
            </tbody>
          </table>
        </Card>
      </SubSection>
    </Section>
  );
}

function ListToolbarSection() {
  return (
    <Section
      id="list-toolbar"
      title="ListToolbar"
      description="components/ui.tsx — standard header row for settings list pages. Muted hint left, result count + actions right, primary Create button last. Don't hand-roll flex + spacer per page."
    >
      <div className="space-y-3">
        <Card>
          <ListToolbar
            hint="Reusable quick prompts"
            count="8 total"
            actions={
              <Button size="sm">
                <Plus size={14} className="mr-1" />
                Create prompt
              </Button>
            }
          />
        </Card>
        <Card>
          <ListToolbar
            hint="Connected email accounts"
            count="3 accounts"
            actions={
              <>
                <Button size="sm" variant="ghost">
                  <RefreshCw size={14} />
                </Button>
                <Button size="sm">
                  <Plus size={14} className="mr-1" />
                  Create account
                </Button>
              </>
            }
          />
        </Card>
      </div>
      <CodeSnippet
        code={`<ListToolbar
  hint="Reusable quick prompts"
  count={\`\${prompts.length} total\`}
  actions={
    <Button size="sm" onClick={openCreate}>
      <Plus size={14} className="mr-1" /> Create prompt
    </Button>
  }
/>`}
      />
    </Section>
  );
}

function EmptyStatesSection() {
  return (
    <Section
      id="empty-states"
      title="Empty State"
      description="components/ui.tsx — placeholder when content is empty. Always use a Lucide icon, never emoji. Pass action for a primary CTA (e.g. the same Create button as the toolbar)."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <EmptyState icon={Search} title="No results found" description="Try adjusting your search or filters." />
        </Card>
        <Card>
          <EmptyState icon={Mail} title="No messages" description="Start a conversation to see messages here." />
        </Card>
        <Card>
          <EmptyState
            icon={HelpCircle}
            title="No prompts yet"
            description="Create your first prompt to speed up common tasks."
            action={
              <Button size="sm">
                <Plus size={14} className="mr-1" />
                Create prompt
              </Button>
            }
          />
        </Card>
        <Card>
          <EmptyState icon={Copy} title="No items yet" />
        </Card>
      </div>
      <CodeSnippet
        code={`<EmptyState
  icon={Search}
  title="No prompts yet"
  description="Create your first prompt to speed up common tasks."
  action={
    <Button size="sm" onClick={openCreate}>
      <Plus size={14} className="mr-1" /> Create prompt
    </Button>
  }
/>`}
      />
    </Section>
  );
}

function StarRatingSection() {
  const [rating, setRating] = useState(3);

  return (
    <Section
      id="star-rating"
      title="Star Rating"
      description="components/ui.tsx — 1-5 star rating for feedback collection."
    >
      <SubSection title="Interactive">
        <DemoRow>
          <StarRating value={rating} onChange={setRating} />
          <span className="text-sm text-fg-muted">Value: {rating}</span>
        </DemoRow>
      </SubSection>

      <SubSection title="Read-only">
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((v) => (
            <DemoRow key={v}>
              <StarRating value={v} readonly />
              <span className="text-xs text-fg-faint">
                {v} star{v !== 1 ? 's' : ''}
              </span>
            </DemoRow>
          ))}
        </div>
      </SubSection>
    </Section>
  );
}

function DataTableSection() {
  const data: DataTableData = {
    title: 'Sample Products',
    columns: [
      { key: 'name', label: 'Product', type: 'text' },
      { key: 'price', label: 'Price', type: 'currency' },
      { key: 'growth', label: 'Growth', type: 'percent' },
      { key: 'stock', label: 'In Stock', type: 'boolean' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    rows: [
      { name: 'Smart Pot Pro', price: 129.99, growth: 0.234, stock: true, status: 'Active' },
      { name: 'Herb Garden Kit', price: 49.99, growth: 0.087, stock: true, status: 'Active' },
      { name: 'Indoor Planter', price: 79.99, growth: -0.034, stock: false, status: 'Low Stock' },
      { name: 'Grow Light Panel', price: 199.99, growth: 0.156, stock: true, status: 'New' },
      { name: 'Soil Sensor V2', price: 29.99, growth: -0.112, stock: false, status: 'Discontinued' },
    ],
  };

  return (
    <Section
      id="datatable"
      title="DataTable Block"
      description="components/blocks/datatable-block.tsx — sortable, filterable table. Rendered from code fences or directly."
    >
      <DataTableBlock data={data} />
      <CodeSnippet
        code={`import { DataTableBlock } from '../components/blocks/datatable-block';

<DataTableBlock data={{
  title: 'Products',
  columns: [
    { key: 'name', label: 'Product', type: 'text' },
    { key: 'price', label: 'Price', type: 'currency' },
    { key: 'growth', label: 'Growth', type: 'percent' },
    { key: 'stock', label: 'In Stock', type: 'boolean' },
    { key: 'status', label: 'Status', type: 'badge' },
  ],
  rows: [...]
}} />`}
      />
    </Section>
  );
}

function ChartSection() {
  const barData: ChartData = {
    type: 'bar',
    title: 'Monthly Revenue',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    datasets: [
      { label: 'Revenue', data: [4200, 5100, 4800, 6200, 5900, 7100] },
      { label: 'Cost', data: [2800, 3200, 3100, 3800, 3500, 4200] },
    ],
  };

  const lineData: ChartData = {
    type: 'line',
    title: 'User Growth',
    labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
    datasets: [{ label: 'Users', data: [120, 190, 250, 310, 380, 450] }],
  };

  const pieData: ChartData = {
    type: 'doughnut',
    title: 'Traffic Sources',
    labels: ['Direct', 'Organic', 'Referral', 'Social'],
    datasets: [{ label: 'Visits', data: [35, 40, 15, 10] }],
  };

  return (
    <Section
      id="chart"
      title="Chart Block"
      description="components/blocks/chart-block.tsx — Chart.js powered. Supports bar, line, pie, doughnut, radar."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-medium text-fg-secondary mb-2">Bar Chart</h3>
          <ChartBlock data={barData} />
        </div>
        <div>
          <h3 className="text-sm font-medium text-fg-secondary mb-2">Line Chart</h3>
          <ChartBlock data={lineData} />
        </div>
      </div>
      <div className="max-w-sm">
        <h3 className="text-sm font-medium text-fg-secondary mb-2">Doughnut Chart</h3>
        <ChartBlock data={pieData} />
      </div>
      <CodeSnippet
        code={`<ChartBlock data={{
  type: 'bar',
  title: 'Monthly Revenue',
  labels: ['Jan', 'Feb', 'Mar'],
  datasets: [{ label: 'Revenue', data: [4200, 5100, 4800] }],
}} />`}
      />
    </Section>
  );
}

function ConfirmBlockSection() {
  return (
    <Section
      id="confirm-block"
      title="Confirm Block"
      description="components/blocks/confirm-block.tsx — inline action buttons for agent responses."
    >
      <SubSection title="Active (awaiting input)">
        <ConfirmBlock
          data={{
            text: 'Would you like to proceed with the import? This will add 42 new records.',
            actions: [
              { label: 'Import All', value: 'import_all', variant: 'primary' },
              { label: 'Preview First', value: 'preview', variant: 'secondary' },
              { label: 'Cancel', value: 'cancel', variant: 'destructive' },
            ],
          }}
          onAction={(v) => toast(`Selected: ${v}`, 'info')}
        />
      </SubSection>

      <SubSection title="Without handler (read-only)">
        <ConfirmBlock
          data={{
            text: 'Choose a deployment target:',
            actions: [
              { label: 'Staging', value: 'staging' },
              { label: 'Production', value: 'production' },
            ],
          }}
        />
      </SubSection>
      <CodeSnippet
        code={`<ConfirmBlock
  data={{
    text: 'Proceed with import?',
    actions: [
      { label: 'Yes', value: 'yes', variant: 'primary' },
      { label: 'No', value: 'no', variant: 'secondary' },
    ],
  }}
  onAction={(value) => handleAction(value)}
/>`}
      />
    </Section>
  );
}

// ═══════════════════════════════════════════════════════════
// NEW PRIMITIVES
// ═══════════════════════════════════════════════════════════

function SearchInputSection() {
  const [search, setSearch] = useState('');

  return (
    <Section
      id="search-input"
      title="SearchInput"
      description="components/ui.tsx — icon-prefixed search field. Replaces the repeated Search icon + Input wrapper pattern."
    >
      <SubSection title="Sizes">
        <DemoRow>
          <SearchInput value={search} onChange={setSearch} placeholder="Small (default)" size="sm" className="w-48" />
          <SearchInput value={search} onChange={setSearch} placeholder="Medium" size="md" className="w-64" />
        </DemoRow>
      </SubSection>
      <CodeSnippet
        code={`<SearchInput\n  value={search}\n  onChange={setSearch}\n  placeholder="Search..."\n  size="sm"\n  className="w-48"\n/>`}
      />
    </Section>
  );
}

function CheckboxSection() {
  const [checked, setChecked] = useState(false);
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setMulti((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  return (
    <Section
      id="checkbox"
      title="Checkbox"
      description="components/ui.tsx — styled checkbox with optional label. Replaces raw <input type=checkbox>."
    >
      <SubSection title="Basic">
        <DemoRow>
          <Checkbox checked={checked} onChange={() => setChecked(!checked)} />
          <span className="text-sm text-fg-muted">checked: {String(checked)}</span>
        </DemoRow>
      </SubSection>
      <SubSection title="With Label">
        <div className="space-y-2">
          <Checkbox checked={multi.has('a')} onChange={() => toggle('a')} label="Enable notifications" />
          <Checkbox checked={multi.has('b')} onChange={() => toggle('b')} label="Auto-save drafts" />
          <Checkbox checked={false} onChange={() => {}} label="Disabled option" disabled />
        </div>
      </SubSection>
      <CodeSnippet
        code={`<Checkbox checked={v} onChange={() => setV(!v)} />\n<Checkbox checked={v} onChange={fn} label="Enable feature" />\n<Checkbox checked={false} onChange={fn} label="Disabled" disabled />`}
      />
    </Section>
  );
}

function ToggleSection() {
  const [on, setOn] = useState(false);

  return (
    <Section
      id="toggle"
      title="Toggle"
      description="components/ui.tsx — switch toggle. Replaces the hand-rolled role=switch pattern."
    >
      <SubSection title="Sizes">
        <DemoRow>
          <Toggle checked={on} onChange={setOn} size="sm" />
          <Toggle checked={on} onChange={setOn} size="md" />
          <span className="text-sm text-fg-muted">{on ? 'On' : 'Off'}</span>
        </DemoRow>
      </SubSection>
      <SubSection title="States">
        <DemoRow>
          <Toggle checked={true} onChange={() => {}} />
          <span className="text-xs text-fg-faint">On</span>
          <Toggle checked={false} onChange={() => {}} />
          <span className="text-xs text-fg-faint">Off</span>
          <Toggle checked={true} onChange={() => {}} disabled />
          <span className="text-xs text-fg-faint">Disabled</span>
        </DemoRow>
      </SubSection>
      <CodeSnippet
        code={`<Toggle checked={on} onChange={setOn} size="sm" />\n<Toggle checked={on} onChange={setOn} disabled />`}
      />
    </Section>
  );
}

function DateRangeSection() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dtFrom, setDtFrom] = useState('');
  const [dtTo, setDtTo] = useState('');

  return (
    <Section
      id="date-range"
      title="DateRangeInput"
      description="components/ui.tsx — paired From/To date inputs. Zero-dependency, native browser date picker."
    >
      <SubSection title="Date">
        <DateRangeInput
          from={from}
          to={to}
          onChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
        />
      </SubSection>
      <SubSection title="Datetime">
        <DateRangeInput
          from={dtFrom}
          to={dtTo}
          onChange={(f, t) => {
            setDtFrom(f);
            setDtTo(t);
          }}
          type="datetime-local"
        />
      </SubSection>
      <CodeSnippet
        code={`<DateRangeInput\n  from={from}\n  to={to}\n  onChange={(f, t) => { setFrom(f); setTo(t); }}\n  type="date"  // or "datetime-local"\n/>`}
      />
    </Section>
  );
}

function AvatarSection() {
  return (
    <Section
      id="avatar"
      title="Avatar"
      description="components/ui.tsx — user avatar circle. Shows initial from name or fallback icon."
    >
      <SubSection title="Sizes">
        <DemoRow>
          {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <Avatar name="Jim" size={s} variant="primary" />
              <CodeLabel>{s}</CodeLabel>
            </div>
          ))}
        </DemoRow>
      </SubSection>
      <SubSection title="Variants">
        <DemoRow>
          <Avatar name="Alice" variant="default" />
          <span className="text-xs text-fg-faint">default</span>
          <Avatar name="Bob" variant="primary" />
          <span className="text-xs text-fg-faint">primary</span>
        </DemoRow>
      </SubSection>
      <SubSection title="Fallback (no name)">
        <DemoRow>
          <Avatar size="sm" />
          <Avatar size="md" />
          <span className="text-xs text-fg-faint">Shows User icon when name is not provided</span>
        </DemoRow>
      </SubSection>
      <CodeSnippet code={`<Avatar name="Jim" size="md" variant="primary" />\n<Avatar size="sm" />  // fallback icon`} />
    </Section>
  );
}

function StatusDotSection() {
  return (
    <Section
      id="status-dot"
      title="StatusDot"
      description="components/ui.tsx — colored indicator dot for online/offline, read/unread status."
    >
      <SubSection title="Colors">
        <DemoRow>
          {(['success', 'warning', 'danger', 'info', 'primary', 'muted'] as const).map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <StatusDot color={c} />
              <span className="text-xs text-fg-muted">{c}</span>
            </div>
          ))}
        </DemoRow>
      </SubSection>
      <SubSection title="Sizes & Pulse">
        <DemoRow>
          <StatusDot color="success" size="sm" />
          <span className="text-xs text-fg-faint">sm</span>
          <StatusDot color="success" size="md" />
          <span className="text-xs text-fg-faint">md</span>
          <StatusDot color="success" pulse />
          <span className="text-xs text-fg-faint">pulse</span>
        </DemoRow>
      </SubSection>
      <SubSection title="Usage Example">
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <StatusDot color="success" pulse />
            <span className="text-sm text-fg">Device online</span>
          </div>
        </Card>
      </SubSection>
      <CodeSnippet code={`<StatusDot color="success" pulse />\n<StatusDot color="muted" size="sm" />`} />
    </Section>
  );
}

function MarkdownSection() {
  const sampleMd = `# Heading 1

## Heading 2

A paragraph with **bold**, *italic*, and \`inline code\`.

Second paragraph showing spacing between blocks.

- Item one
- Item two
- Item three

| Column A | Column B | Column C |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |

> Blockquote text here.

\`\`\`js
const greeting = "hello";
console.log(greeting);
// This is a comment
\`\`\``;

  return (
    <Section
      id="markdown"
      title="Markdown"
      description="components/markdown.tsx — two variants: prose-base (wiki/docs, spacious) and prose-compact (chat/agent, tight)."
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider mb-2">
            prose-base (Wiki / Docs)
          </p>
          <Card className="p-4">
            <Markdown content={sampleMd} />
          </Card>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider mb-2">
            prose-compact (Chat Messages)
          </p>
          <Card className="p-4">
            <Markdown content={sampleMd} compact />
          </Card>
        </div>
      </div>
      <CodeSnippet
        code={`import { Markdown } from '../components/markdown';

// Wiki / docs (default — spacious)
<Markdown content={markdownString} />

// Chat / agent messages (compact)
<Markdown content={markdownString} compact />`}
      />
    </Section>
  );
}

function RichMarkdownSection() {
  const sample = `Here is a chart:

\`\`\`chart
{
  "type": "bar",
  "title": "Embedded Chart",
  "labels": ["A", "B", "C"],
  "datasets": [{"label": "Value", "data": [30, 50, 20]}]
}
\`\`\`

And a data table:

\`\`\`datatable
{
  "title": "Inline Table",
  "columns": [
    {"key": "name", "label": "Name", "type": "text"},
    {"key": "count", "label": "Count", "type": "number"}
  ],
  "rows": [
    {"name": "Alpha", "count": 100},
    {"name": "Beta", "count": 200}
  ]
}
\`\`\`

Plus a confirm block:

\`\`\`confirm
{
  "text": "Do you approve this?",
  "actions": [
    {"label": "Approve", "value": "yes", "variant": "primary"},
    {"label": "Reject", "value": "no", "variant": "destructive"}
  ]
}
\`\`\`

And a local file preview:

\`\`\`html-preview
{ "src": "/Users/jim/code/OpenGreensy/slides.html", "title": "OpenGreensy Slides" }
\`\`\``;

  return (
    <Section
      id="rich-markdown"
      title="Rich Markdown"
      description="components/rich-markdown.tsx — enhanced renderer that parses chart/datatable/confirm and local file preview code fences into interactive blocks."
    >
      <Card className="p-4">
        <RichMarkdown content={sample} onConfirmAction={(v) => toast(`Action: ${v}`, 'info')} />
      </Card>
      <CodeSnippet
        code={`import { RichMarkdown } from '../components/rich-markdown';

<RichMarkdown
  content={markdownWithBlocks}
  onConfirmAction={(value) => handleAction(value)}
/>`}
      />
    </Section>
  );
}

function ErrorBoundarySection() {
  const BrokenComponent = () => {
    throw new Error('Demo error — this is intentional!');
  };

  return (
    <Section
      id="error-boundary"
      title="Error Boundary"
      description="components/ui.tsx — catches render errors. Wraps main content area and can wrap any subtree."
    >
      <Card className="p-4">
        <ErrorBoundary>
          <BrokenComponent />
        </ErrorBoundary>
      </Card>
      <CodeSnippet
        code={`<ErrorBoundary>
  <SomeComponent />
</ErrorBoundary>

// With custom fallback:
<ErrorBoundary fallback={<p>Something went wrong</p>}>
  <SomeComponent />
</ErrorBoundary>`}
      />
    </Section>
  );
}

function LogoSection() {
  return (
    <Section id="logo" title="App Logo" description="components/ui.tsx — AppLogo component with size variants.">
      <DemoRow>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="sm" />
          <CodeLabel>sm</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="md" />
          <CodeLabel>md</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="lg" />
          <CodeLabel>lg</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="xl" />
          <CodeLabel>xl</CodeLabel>
        </div>
      </DemoRow>
      <DemoRow className="mt-4">
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="md" showVersion />
          <CodeLabel>showVersion</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="sm" logoOnly />
          <CodeLabel>sm logoOnly</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="md" logoOnly />
          <CodeLabel>md logoOnly</CodeLabel>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AppLogo size="xl" logoOnly />
          <CodeLabel>xl logoOnly</CodeLabel>
        </div>
      </DemoRow>
    </Section>
  );
}
