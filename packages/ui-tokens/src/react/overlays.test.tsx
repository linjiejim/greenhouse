/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog, Drawer } from './overlays.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const escape = () =>
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

function Stack({ onDrawer, onDialog }: { onDrawer: () => void; onDialog: () => void }) {
  const [dialog, setDialog] = useState(true);
  return (
    <Drawer title="Asset" onClose={onDrawer}>
      <p>detail</p>
      {dialog ? (
        <Dialog
          title="Rename"
          onClose={() => {
            onDialog();
            setDialog(false);
          }}
        >
          <input aria-label="name" />
        </Dialog>
      ) : null}
    </Drawer>
  );
}

it('closes one layer per Escape and dims only behind the lowest one', () => {
  const onDrawer = vi.fn(),
    onDialog = vi.fn();
  mount(<Stack onDrawer={onDrawer} onDialog={onDialog} />);
  const scrims = () => [...document.querySelectorAll('.bg-scrim')];
  expect(scrims()).toHaveLength(1);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('name');
  escape();
  expect(onDialog).toHaveBeenCalledOnce();
  expect(onDrawer).not.toHaveBeenCalled();
  escape();
  expect(onDrawer).toHaveBeenCalledOnce();
});

function Later({ onDialog }: { onDialog: () => void }) {
  const [dialog, setDialog] = useState(false);
  return (
    <Drawer title="Asset" onClose={() => {}}>
      <button onClick={() => setDialog(true)}>rename</button>
      {dialog ? (
        <Dialog title="Rename" onClose={onDialog}>
          <input aria-label="later-name" />
        </Dialog>
      ) : null}
    </Drawer>
  );
}

it('moves focus into a dialog opened later above a drawer', () => {
  mount(<Later onDialog={() => {}} />);
  const open = [...document.querySelectorAll('button')].find((b) => b.textContent === 'rename')!;
  open.focus();
  act(() => open.click());
  expect(document.activeElement?.getAttribute('aria-label')).toBe('later-name');
});
