import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OverlayFrame, type OverlayVariant } from './overlay-frame';
import { ConfirmDialog, Dialog } from './ui';

const VARIANTS: OverlayVariant[] = ['center', 'alert', 'palette'];

function renderFrame(variant: OverlayVariant) {
  return renderToStaticMarkup(
    createElement(OverlayFrame, {
      open: true,
      onClose: vi.fn(),
      variant,
      ariaLabel: 'Frame',
      children: createElement('p', null, 'body'),
    }),
  );
}

/** The outermost element — the one whose content box every `max-h-full` resolves against. */
function containerTag(html: string) {
  return html.slice(0, html.indexOf('>') + 1);
}

function surfaceTag(html: string) {
  const match = html.match(/<div[^>]*role="(?:dialog|alertdialog)"[^>]*>/);
  if (!match) throw new Error('no overlay surface in markup');
  return match[0];
}

describe('OverlayFrame', () => {
  it.each(VARIANTS)('caps %s height against the padded container, never a viewport constant', (variant) => {
    // 这条锁死底座存在的理由：安全区 padding 挂在**最外层容器**，弹层自己只写
    // max-h-full。百分比高度相对容器 content box，env() 已经被扣掉，所以「容器
    // padding 变化时高度上限自动跟随」。任何一方跑偏——padding 搬到弹层自身、
    // 或者高度写成 calc(100dvh - 常数)——刘海机上就会算漏 62+34px，移动端
    // items-end 把溢出部分从顶部顶出屏幕，标题栏连同关闭按钮一起消失。
    const html = renderFrame(variant);

    expect(containerTag(html)).toContain('mobile-visual-viewport');
    expect(containerTag(html)).toContain('env(safe-area-inset-top)');
    expect(containerTag(html)).toContain('env(safe-area-inset-bottom)');
    expect(surfaceTag(html)).toContain('max-h-full');
    expect(html).not.toContain('dvh');
    // 两处 env() 必须都在容器上——出现第三处意味着有人又把 safe-area 搬回了弹层自身。
    expect(html.split('env(safe-area-inset').length - 1).toBe(2);
  });

  it('exposes one accessible surface per overlay, labelled by its caller', () => {
    const html = renderFrame('alert');
    expect(surfaceTag(html)).toContain('aria-modal="true"');
    expect(surfaceTag(html)).toContain('aria-label="Frame"');
    expect(html.match(/aria-modal/g)).toHaveLength(1);
  });

  it('renders nothing while closed, so callers can mount it unconditionally', () => {
    const html = renderToStaticMarkup(
      createElement(OverlayFrame, {
        open: false,
        onClose: vi.fn(),
        variant: 'center',
        ariaLabel: 'Frame',
        children: createElement('p', null, 'body'),
      }),
    );
    expect(html).toBe('');
  });

  it('keeps the dialog family on the shared frame instead of hand-rolled containment', () => {
    const dialog = renderToStaticMarkup(
      createElement(Dialog, {
        open: true,
        onClose: vi.fn(),
        title: 'History',
        children: createElement('p', null, 'body'),
      }),
    );
    const confirm = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
        title: 'Delete conversation',
      }),
    );

    for (const html of [dialog, confirm]) {
      expect(containerTag(html)).toContain('env(safe-area-inset-top)');
      expect(surfaceTag(html)).toContain('max-h-full');
      expect(html).not.toContain('dvh');
    }
  });
});
