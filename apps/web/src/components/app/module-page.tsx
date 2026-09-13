/**
 * Inner page frame for Settings / Administration-style module pages.
 *
 * ModulePageShell owns the module navigation and viewport. ModulePage owns the
 * identity header, optional page-level slots, content width, and scroll model.
 */

import React from 'react';
import { getNavModule, localizeNavModule } from '../../lib/nav-registry';
import { useT } from '../../lib/i18n';

export type ModulePageLayout = 'form' | 'list' | 'canvas';

interface ModulePageProps {
  moduleId: string;
  layout: ModulePageLayout;
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  tabs?: React.ReactNode;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

const CONTENT_WIDTH: Record<ModulePageLayout, string> = {
  form: 'max-w-[60rem]',
  list: 'max-w-[80rem]',
  canvas: 'max-w-none',
};

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function ModulePage({
  moduleId,
  layout,
  actions,
  notice,
  tabs,
  toolbar,
  children,
  className,
  contentClassName,
}: ModulePageProps) {
  const t = useT();
  const registeredModule = getNavModule(moduleId);

  if (!registeredModule) {
    throw new Error(`Unknown navigation module: ${moduleId}`);
  }

  const module = localizeNavModule(registeredModule, t);
  const Icon = module.icon;
  const isCanvas = layout === 'canvas';

  const body = (
    <div
      className={joinClasses(
        'mx-auto flex w-full flex-col',
        CONTENT_WIDTH[layout],
        isCanvas ? 'h-full min-h-0 px-3 py-3 md:px-4' : 'px-3 py-3 sm:px-5 md:px-6 md:py-4 lg:px-8',
        className,
      )}
    >
      <header className="flex flex-shrink-0 flex-col gap-2.5 border-b border-edge pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-primary-edge bg-primary-subtle text-primary-fg shadow-sm">
            <Icon size={16} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-5 text-fg md:text-lg" title={module.label}>
              {module.label}
            </h1>
            {module.description && (
              <p className="mt-0.5 max-w-3xl truncate text-xs leading-4 text-fg-muted" title={module.description}>
                {module.description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div
            data-module-page-slot="actions"
            className="flex w-full flex-shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&_button]:w-full sm:[&_button]:w-auto"
          >
            {actions}
          </div>
        )}
      </header>

      <div className={joinClasses('mt-3 flex min-h-0 flex-1 flex-col gap-3', isCanvas && 'overflow-hidden')}>
        {notice && <div data-module-page-slot="notice">{notice}</div>}
        {tabs && <div data-module-page-slot="tabs">{tabs}</div>}
        {toolbar && (
          <div
            data-module-page-slot="toolbar"
            className="rounded-xl border border-edge bg-surface-raised px-3 py-2.5 shadow-sm"
          >
            {toolbar}
          </div>
        )}
        <div className={joinClasses(isCanvas && 'min-h-0 flex-1 overflow-hidden', contentClassName)}>{children}</div>
      </div>
    </div>
  );

  return (
    <section
      data-module-page={moduleId}
      data-module-page-layout={layout}
      className={joinClasses('h-full', isCanvas ? 'overflow-hidden' : 'overflow-y-auto')}
    >
      {body}
    </section>
  );
}
