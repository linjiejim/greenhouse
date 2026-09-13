import React from 'react';

type FormControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
};

export function FormField({
  label,
  children,
  help,
  error,
  required = false,
  className = '',
}: {
  label: React.ReactNode;
  children: React.ReactElement<FormControlProps>;
  help?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  const generatedId = React.useId();
  const controlId = children.props.id ?? generatedId;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const describedBy = [children.props['aria-describedby'], help ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label htmlFor={controlId} className="mb-1.5 block text-xs font-medium text-fg-secondary">
        {label}
        {required && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {React.cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : children.props['aria-invalid'],
      })}
      {help && (
        <p id={helpId} className="mt-1 text-[11px] leading-4 text-fg-faint">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-[11px] leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormGrid({
  children,
  columns = 2,
  className = '',
}: {
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const columnsClass = columns === 1 ? '' : columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  return <div className={`grid grid-cols-1 gap-3 ${columnsClass} ${className}`}>{children}</div>;
}

export function FormGroup({
  label,
  help,
  children,
  className = '',
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const labelId = React.useId();
  const helpId = React.useId();
  return (
    <div className={className}>
      <div id={labelId} className="mb-1.5 text-xs font-medium text-fg-secondary">
        {label}
      </div>
      <div role="group" aria-labelledby={labelId} aria-describedby={help ? helpId : undefined}>
        {children}
      </div>
      {help && (
        <p id={helpId} className="mt-1 text-[11px] leading-4 text-fg-faint">
          {help}
        </p>
      )}
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-t border-edge pt-4 ${className}`}>
      {(title || description) && (
        <div className="mb-3">
          {title && <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{title}</h4>}
          {description && <p className="mt-1 text-[11px] leading-4 text-fg-faint">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function FormActions({
  children,
  leading,
  className = '',
}: {
  children: React.ReactNode;
  leading?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 pt-2 ${className}`}>
      {leading}
      <div className="flex-1" />
      {children}
    </div>
  );
}

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
      {children}
    </div>
  );
}
