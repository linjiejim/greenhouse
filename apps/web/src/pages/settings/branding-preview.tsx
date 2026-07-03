/**
 * BrandingPreview — the live specimen canvas of the Branding Studio.
 *
 * One continuous `bg-surface` sheet (not a stack of cards) so brand color,
 * typography and radius edits read as a single coherent product surface.
 * Sections are separated by a light underline; the chat block mirrors the
 * classes used by components/chat/message.tsx. Purely presentational.
 */

import React, { useState } from 'react';
import { Button, Badge, Tag, Input, Toggle, StatusDot } from '../../components/ui';
import { Sparkles } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-edge last:border-b-0">
      <h3 className="text-[11px] font-semibold text-fg-faint uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </section>
  );
}

export function BrandingPreview() {
  const { t } = useI18n();
  const [toggleOn, setToggleOn] = useState(true);

  return (
    <div className="bg-surface border border-edge rounded-2xl overflow-hidden shadow-sm">
      {/* Typography */}
      <Row title={t('brandingStudio.pvTypography')}>
        <h2 className="text-lg font-semibold text-fg mb-1">{t('brandingStudio.sampleHeading')}</h2>
        <p className="text-sm text-fg-secondary mb-1.5">{t('brandingStudio.sampleBody')}</p>
        <p className="text-[10px] text-fg-faint font-mono">{t('brandingStudio.sampleMeta')}</p>
      </Row>

      {/* Buttons + form */}
      <Row title={t('brandingStudio.pvControls')}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Button size="sm">{t('brandingStudio.samplePrimaryBtn')}</Button>
          <Button size="sm" variant="secondary">
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="destructive">
            {t('common.delete')}
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Input placeholder={t('brandingStudio.sampleInput')} className="max-w-xs" />
          <div className="flex items-center gap-2 flex-shrink-0">
            <Toggle checked={toggleOn} onChange={setToggleOn} size="sm" />
            <span className="text-sm text-fg-secondary">{t('brandingStudio.sampleToggle')}</span>
          </div>
        </div>
      </Row>

      {/* Semantic tones */}
      <Row title={t('brandingStudio.pvSemantic')}>
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <Tag tone="neutral">neutral</Tag>
          <Tag tone="primary">primary</Tag>
          <Tag tone="success">success</Tag>
          <Tag tone="warning">warning</Tag>
          <Tag tone="danger">danger</Tag>
          <Tag tone="info">info</Tag>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-fg-secondary">
          <span className="flex items-center gap-1.5">
            <StatusDot color="success" /> {t('brandingStudio.sampleOnline')}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot color="warning" pulse /> {t('brandingStudio.sampleRunning')}
          </span>
          <Badge variant="destructive">{t('brandingStudio.sampleFailed')}</Badge>
        </div>
      </Row>

      {/* Chat — mirrors components/chat/message.tsx classes */}
      <Row title={t('brandingStudio.pvChat')}>
        <div className="space-y-3">
          <div className="flex justify-end">
            <div className="max-w-[80%] bg-primary-subtle border border-primary-edge rounded-xl rounded-br-md px-4 py-3">
              <p className="text-sm text-fg">{t('brandingStudio.sampleUserMsg')}</p>
            </div>
          </div>
          <div className="max-w-[92%] prose-compact">
            <p>{t('brandingStudio.sampleAssistantMsg')}</p>
            <ul>
              <li>
                <strong>Platform</strong> — {t('brandingStudio.sampleBullet1')}
              </li>
              <li>
                <strong>API</strong> — {t('brandingStudio.sampleBullet2')}{' '}
                <a href="#/settings/branding" onClick={(e) => e.preventDefault()}>
                  {t('brandingStudio.sampleLink')}
                </a>
              </li>
            </ul>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-fg-faint">
            <Sparkles size={10} />
            <span>{t('brandingStudio.sampleModelMeta')}</span>
          </div>
        </div>
      </Row>
    </div>
  );
}
