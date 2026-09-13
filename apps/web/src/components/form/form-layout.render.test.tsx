import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Input } from '../ui';
import { FormActions, FormField, FormGrid } from './form-layout';

describe('shared form layout', () => {
  it('associates labels, help, errors, and invalid state with the control', () => {
    const html = renderToStaticMarkup(
      <FormField label="Project name" help="Visible to the team" error="Name is required" required>
        <Input />
      </FormField>,
    );

    const id = html.match(/<input[^>]*\sid="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-help ${id}-error"`);
    expect(html).toContain('aria-invalid="true"');
  });

  it('keeps grids mobile-first and actions wrapping', () => {
    const html = renderToStaticMarkup(
      <>
        <FormGrid>
          <Input />
          <Input />
        </FormGrid>
        <FormActions leading={<span>Required</span>}>
          <Button>Save</Button>
        </FormActions>
      </>,
    );

    expect(html).toContain('grid-cols-1');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).toContain('flex-wrap');
  });
});
