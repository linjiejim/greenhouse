/** Permission-filtered, one-click starter workbenches. */

import { findRecipe, type WorkbenchTemplate, type WorkbenchTemplateId } from '@greenhouse/types/workbench';
import { Dialog } from '../ui';
import { ArrowRight, FolderKanban, type LucideIcon } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { recipeLabels, templateLabels } from '../../lib/workbench/recipes';

const TEMPLATE_ICONS: Record<WorkbenchTemplateId, LucideIcon> = {
  projects: FolderKanban,
};

interface TemplateDialogProps {
  open: boolean;
  templates: readonly WorkbenchTemplate[];
  onClose: () => void;
  onSelect: (template: WorkbenchTemplate) => void;
}

export function TemplateDialog({ open, templates, onClose, onSelect }: TemplateDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t('home.templates')} size="lg">
      <p className="mb-4 text-sm text-fg-muted">{t('home.templatesDescription')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {templates.map((template) => {
          const Icon = TEMPLATE_ICONS[template.id];
          const labels = templateLabels(template);
          const title = t(labels.labelKey);
          const recipes = template.cards
            .map((card) => findRecipe(card.recipeId))
            .filter((recipe) => recipe !== undefined);
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template)}
              aria-label={`${t('home.replaceWithTemplate')}: ${title}`}
              className="group flex min-h-56 flex-col rounded-xl border border-edge bg-surface-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            >
              <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong">
                <Icon size={20} />
              </span>
              <span className="text-sm font-semibold text-fg">{title}</span>
              <span className="mt-1 text-xs leading-5 text-fg-muted">{t(labels.descriptionKey)}</span>
              <span className="mt-3 flex flex-wrap gap-1.5">
                {recipes.map((recipe) => (
                  <span key={recipe.id} className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-fg-muted">
                    {t(recipeLabels(recipe).labelKey)}
                  </span>
                ))}
              </span>
              <span className="mt-auto flex w-full items-center justify-between pt-4 text-xs font-medium text-primary-700">
                {t('home.templateCardCount', { count: template.cards.length })}
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
