/**
 * Browser-side labels for the shared recipe catalog.
 *
 * The recipes themselves — tool, input, mapping, default size — live in
 * `@greenhouse/types/workbench`, because the card picker and the `workbench_query`
 * tool must offer the identical list. What lives here is only the part the
 * catalog cannot own: which translation key renders each entry, since the
 * shared list ships one English label for the agent to read.
 *
 * The `Record<WidgetRecipeId, …>` is deliberate: adding a recipe to the shared
 * catalog fails to compile here until it has translations.
 */

import {
  WIDGET_RECIPES,
  type WidgetRecipe,
  type WidgetRecipeId,
  type WorkbenchTemplate,
  type WorkbenchTemplateId,
} from '@greenhouse/types/workbench';
import type { TranslationKey } from '../i18n';

export { availableRecipes, findRecipe } from '@greenhouse/types/workbench';
export type { WidgetRecipe, WidgetRecipeId } from '@greenhouse/types/workbench';

interface RecipeLabels {
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}

const RECIPE_LABELS: Record<WidgetRecipeId, RecipeLabels> = {
  'projects.list': {
    labelKey: 'home.recipe.projectsList',
    descriptionKey: 'home.recipe.projectsListDesc',
  },
  'projects.active': {
    labelKey: 'home.recipe.projectsActive',
    descriptionKey: 'home.recipe.projectsActiveDesc',
  },
  'projects.planning': {
    labelKey: 'home.recipe.projectsPlanning',
    descriptionKey: 'home.recipe.projectsPlanningDesc',
  },
  'projects.on_hold': {
    labelKey: 'home.recipe.projectsOnHold',
    descriptionKey: 'home.recipe.projectsOnHoldDesc',
  },
};

export function recipeLabels(recipe: WidgetRecipe): RecipeLabels {
  return RECIPE_LABELS[recipe.id];
}

interface TemplateLabels {
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}

const TEMPLATE_LABELS: Record<WorkbenchTemplateId, TemplateLabels> = {
  projects: {
    labelKey: 'home.template.projects',
    descriptionKey: 'home.template.projectsDesc',
  },
};

export function templateLabels(template: WorkbenchTemplate): TemplateLabels {
  return TEMPLATE_LABELS[template.id];
}

export { WIDGET_RECIPES };
