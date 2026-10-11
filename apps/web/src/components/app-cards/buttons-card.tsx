/**
 * Buttons card (`kind: 'buttons'`): the role's buttons (the gateway already
 * dropped the others). `open_page` moves within the app, `open_url` follows
 * the cards-block link rule (`openCardUrl`: a record reference opens as a
 * peek, anything else in a new tab) after re-checking the spec's URL rule,
 * `create_record` asks the host for the create form.
 */

import type { AppButton } from '@greenhouse/types/apps';
import { Button, toast } from '../ui';
import { useT } from '../../lib/i18n';
import { ArrowRight, ExternalLink, Plus, type LucideIcon } from '../../lib/icons';
import { openCardUrl } from '../../lib/rich-output';
import { isSafeAppUrl } from './model';
import type { AppCardRendererProps } from './types';

const BUTTON_ICONS: Record<AppButton['type'], LucideIcon> = {
  open_page: ArrowRight,
  open_url: ExternalLink,
  create_record: Plus,
};

export function AppButtonsCard({ card, host }: AppCardRendererProps<'buttons'>) {
  const t = useT();
  const press = (button: AppButton) => {
    switch (button.type) {
      case 'open_page':
        host.openPage(button.pageId);
        return;
      case 'open_url':
        if (isSafeAppUrl(button.url)) openCardUrl(button.url.trim(), button.label);
        else toast(t('apps.runtime.cards.badLink'), 'error');
        return;
      case 'create_record':
        host.openCreate(card, button.id);
        return;
    }
  };
  if (card.buttons.length === 0) {
    return <p className="text-xs text-fg-faint">{t('apps.runtime.cards.noButtons')}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {card.buttons.map((button, index) => {
        const Icon = BUTTON_ICONS[button.type];
        return (
          <Button
            key={button.id}
            variant={index === 0 ? 'default' : 'outline'}
            className="min-h-11 gap-1.5 md:min-h-0"
            onClick={() => press(button)}
            data-testid={`app-button-${button.id}`}
          >
            <Icon size={14} aria-hidden="true" />
            {button.label}
          </Button>
        );
      })}
    </div>
  );
}
