/**
 * @vitest-environment happy-dom
 */

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  SecretField,
  Segmented,
  StatusBadge,
  Tabs,
  Toast,
  statusTone,
} from '../index';
import { active, advance, byRole, click, get, key, render, setupKit } from './harness';

setupKit();

describe('Button', () => {
  it('loading keeps the label as its name, shows a spinner and ignores presses (and form submits)', () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <Button kind="primary" type="submit" loading onClick={onClick}>
          保存
        </Button>
      </form>,
    );
    const button = byRole('button', '保存');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.querySelector('.gh-spinner')).not.toBeNull();
    click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is natively disabled without a reason', () => {
    render(<Button disabled>发布</Button>);
    expect(byRole('button', '发布').hasAttribute('disabled')).toBe(true);
  });
});

describe('Field', () => {
  it('wires its error to the control: aria-invalid and aria-describedby, the required mark in the label', () => {
    render(
      <Field label="标题" error="请输入标题" required>
        <Input />
      </Field>,
    );
    const input = get<HTMLInputElement>('input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const note = document.getElementById(input.getAttribute('aria-describedby')!);
    expect(note?.textContent).toBe('请输入标题');
    expect(note?.getAttribute('role')).toBe('alert');
    expect(get('.gh-field-label-text').textContent).toBe('标题 · 必填');
  });
});

describe('Segmented', () => {
  it('takes strings or value/label pairs and moves with the arrow keys', () => {
    function Theme() {
      const [value, setValue] = useState('light');
      return (
        <Segmented
          label="主题"
          value={value}
          onChange={setValue}
          items={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' },
          ]}
        />
      );
    }
    render(<Theme />);
    const light = byRole('radio', '浅色');
    expect(light.getAttribute('aria-checked')).toBe('true');
    expect(light.tabIndex).toBe(0);
    expect(byRole('radio', '深色').tabIndex).toBe(-1);
    key(light, 'ArrowRight');
    expect(byRole('radio', '深色').getAttribute('aria-checked')).toBe('true');
    expect(active()?.textContent).toBe('深色');
    key(active()!, 'ArrowLeft');
    key(active()!, 'ArrowLeft');
    expect(byRole('radio', '跟随系统').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Tabs', () => {
  it('hides with fewer than two items', () => {
    render(<Tabs items={['表格']} value="表格" onChange={() => {}} />);
    expect(document.querySelector('[role="tablist"]')).toBeNull();
  });

  it('keeps one tab in the Tab order and moves with the arrow keys', () => {
    function Views() {
      const [value, setValue] = useState('');
      return <Tabs items={['表格', '看板', '时间线']} value={value} onChange={setValue} />;
    }
    render(<Views />);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    key(tabs[0], 'ArrowLeft');
    expect(byRole('tab', '时间线').getAttribute('aria-selected')).toBe('true');
    expect(active()?.textContent).toBe('时间线');
  });
});

describe('Checkbox', () => {
  it('is a native checkbox under a drawn box, with a mixed state', () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="选择当前页所有记录" checked={false} indeterminate onChange={onChange} />);
    const input = byRole<HTMLInputElement>('checkbox', '选择当前页所有记录');
    expect(input.indeterminate).toBe(true);
    expect(get('.gh-checkbox').className).toContain('is-mixed');
    click(input);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('SecretField', () => {
  it('never shows the stored value: replacing hands the new one over and clears the input', () => {
    const onSave = vi.fn();
    render(<SecretField label="API Key" configured onSave={onSave} />);
    expect(get('.gh-secret-configured').textContent).toContain('已配置');
    click(byRole('button', '替换'));
    const input = get<HTMLInputElement>('input[type="password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(byRole('button', '保存'));
    expect(onSave).toHaveBeenCalledWith('sk-test');
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('status vocabulary', () => {
  it('yellow only for what needs you, red only for failure, everything else neutral', () => {
    expect(statusTone('需要你')).toBe('warning');
    expect(statusTone('等你接管')).toBe('warning');
    expect(statusTone('结果未知')).toBe('warning');
    expect(statusTone('失败')).toBe('danger');
    expect(statusTone('部分不可用')).toBe('danger');
    expect(statusTone('运行中')).toBe('info');
    expect(statusTone('可用')).toBe('success');
    expect(statusTone('已过期')).toBe('neutral');
    expect(statusTone('未配置')).toBe('neutral');
    expect(statusTone('已取消')).toBe('neutral');
    render(<StatusBadge status="已过期" />);
    expect(get('.gh-badge').className).toBe('gh-badge gh-badge-neutral');
  });
});

describe('Toast', () => {
  it('leaves after 4 s, or 8 s when it offers 撤销', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast text="已保存" onClose={onClose} />);
    advance(3999);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    const undo = vi.fn();
    render(<Toast text="已归档" onClose={onClose} action={{ label: '撤销', onClick: undo }} />);
    advance(4000);
    expect(onClose).toHaveBeenCalledTimes(1);
    click(byRole('button', '撤销'));
    expect(undo).toHaveBeenCalled();
    advance(4000);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('FieldGroup', () => {
  it('names the group by its label and leaves the buttons inside their own names', async () => {
    const { FieldGroup, Button } = await import('../controls');
    render(
      <FieldGroup label="Logo" description="Square pictures look best.">
        <Button>Replace</Button>
        <Button>Remove</Button>
      </FieldGroup>,
    );
    const group = get('[role="group"]');
    const labelId = group.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('Logo');
    expect(group.querySelector('label')).toBeNull();
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Replace', 'Remove']);
  });
});

describe('Banner', () => {
  it('is a status with its action, and closes only when given onClose', () => {
    const onClose = vi.fn();
    render(
      <Banner action={<Button>去添加</Button>} onClose={onClose}>
        先添加一个模型服务
      </Banner>,
    );
    const banner = byRole('status');
    expect(banner.textContent).toContain('先添加一个模型服务');
    expect(byRole('button', '去添加')).toBeTruthy();
    click(byRole('button', '关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);

    render(<Banner tone="warning">没有可关的</Banner>);
    expect(get('.gh-banner-warning').querySelector('button')).toBeNull();
  });
});
