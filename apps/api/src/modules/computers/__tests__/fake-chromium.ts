/**
 * A browser for db tests: answers the DevTools commands the browser service and the vault send
 * over a fake devtools stream (fake-sandbox.ts), on pages the test describes. It records what was
 * typed into a page, so a test can prove a value reached the page and nothing else.
 */

import { frame, NulFramer } from '../cdp.js';
import type { AxNode } from '../snapshot.js';
import type { FakeStream } from './fake-sandbox.js';

export interface FakePage {
  title: string;
  /** What `read` finds. */
  text?: string;
  ax?: AxNode[];
  /** The sign-in fields the vault's finder sees (otp: how many boxes). */
  fields?: { username?: boolean; password?: boolean; otp?: number };
  /** Where Enter or a click leads. */
  onEnter?: string;
  onClick?: string;
  /** DOM attributes by backend node id, for DOM.describeNode. */
  attributes?: Record<number, string[]>;
}

interface Tab {
  targetId: string;
  url: string;
  loaderId: string;
  visible: boolean;
  page: FakePage;
  /** What the page's fields hold, by field and box. */
  values: Record<string, string[]>;
  focused: { field: string; index: number } | null;
  history: string[];
}

export class FakeChromium {
  readonly tabs: Tab[] = [];
  /** Everything typed into a page with Input.insertText, in order. */
  readonly typed: string[] = [];
  readonly keys: string[] = [];
  readonly methods: string[] = [];
  clicks = 0;
  /** How many DevTools connections were opened. */
  connections = 0;
  /** Runs on every click, as a person reaching for the screen at that moment would. */
  onClick: (() => unknown) | null = null;
  private counter = 0;

  constructor(
    private readonly pages: Record<string, FakePage>,
    start: string,
  ) {
    this.open(start);
  }

  /** Takes over a devtools stream: every command written to it is answered on its output. */
  attach(stream: FakeStream) {
    this.connections += 1;
    const framer = new NulFramer();
    stream.input.on('data', (chunk: Buffer) => {
      for (const text of framer.push(chunk)) {
        const message = JSON.parse(text) as {
          id: number;
          method: string;
          params?: Record<string, any>;
          sessionId?: string;
        };
        this.methods.push(message.method);
        const tab = message.sessionId
          ? this.tabs.find((entry) => `S-${entry.targetId}` === message.sessionId)
          : undefined;
        try {
          const result = this.handle(message.method, message.params ?? {}, tab);
          stream.output.write(
            frame({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
          );
        } catch (error) {
          stream.output.write(frame({ id: message.id, error: { code: -32000, message: (error as Error).message } }));
        }
      }
    });
  }

  get current(): Tab {
    return this.tabs.find((tab) => tab.visible) ?? this.tabs[this.tabs.length - 1]!;
  }

  /** What a field of the current page holds. */
  value(field: string, index = 0): string | undefined {
    return this.current.values[field]?.[index];
  }

  open(url: string): Tab {
    for (const tab of this.tabs) tab.visible = false;
    const tab: Tab = {
      targetId: `T${++this.counter}`,
      url: '',
      loaderId: '',
      visible: true,
      page: { title: '' },
      values: {},
      focused: null,
      history: [],
    };
    this.tabs.push(tab);
    this.navigate(tab, url);
    return tab;
  }

  navigate(tab: Tab, url: string) {
    tab.url = url;
    tab.loaderId = `L${++this.counter}`;
    tab.page = this.pages[url] ?? { title: '', text: '' };
    tab.values = {};
    tab.focused = null;
    tab.history.push(url);
  }

  private evaluate(expression: string, tab: Tab): unknown {
    if (expression === 'document.visibilityState') return tab.visible ? 'visible' : 'hidden';
    if (expression === 'document.readyState') return 'complete';
    const waitFor = /innerText\.includes\(("(?:[^"\\]|\\.)*")\)/.exec(expression);
    if (waitFor) return (tab.page.text ?? '').includes(JSON.parse(waitFor[1]!) as string);
    if (expression.includes("querySelectorAll('input, textarea')")) {
      const shown = Object.entries(tab.values)
        .filter(([field]) => field !== 'password')
        .flatMap(([, values]) => values);
      return [tab.page.title, tab.page.text ?? '', ...shown].join('\n');
    }
    if (expression.includes('const body = document.body;')) return tab.page.text ?? '';
    const finder = /\)\((\{[^()]*\})\)$/.exec(expression);
    if (expression.startsWith('(function (op)') && finder) {
      const op = JSON.parse(finder[1]!) as { op: string; field?: string; index?: number };
      const fields = tab.page.fields ?? {};
      if (op.op === 'scan') return { username: !!fields.username, password: !!fields.password, otp: fields.otp ?? 0 };
      const count = op.field === 'otp' ? (fields.otp ?? 0) : fields[op.field as 'username' | 'password'] ? 1 : 0;
      const index = op.index ?? 0;
      if (index >= count) return op.op === 'length' ? -1 : false;
      if (op.op === 'focus') {
        tab.focused = { field: op.field!, index };
        return true;
      }
      if (op.op === 'length') return (tab.values[op.field!]?.[index] ?? '').length;
    }
    throw new Error(`The fake browser cannot run: ${expression.slice(0, 60)}`);
  }

  private handle(method: string, params: Record<string, any>, tab: Tab | undefined): unknown {
    const need = () => {
      if (!tab) throw new Error(`${method} needs a session`);
      return tab;
    };
    switch (method) {
      case 'Target.getTargets':
        return {
          targetInfos: this.tabs.map((entry) => ({
            targetId: entry.targetId,
            type: 'page',
            url: entry.url,
            title: entry.page.title,
          })),
        };
      case 'Target.attachToTarget':
        if (!this.tabs.some((entry) => entry.targetId === params.targetId)) throw new Error('No target with given id');
        return { sessionId: `S-${params.targetId}` };
      case 'Target.getTargetInfo': {
        const found = this.tabs.find((entry) => entry.targetId === params.targetId);
        return {
          targetInfo: {
            targetId: params.targetId,
            type: 'page',
            url: found?.url ?? '',
            title: found?.page.title ?? '',
          },
        };
      }
      case 'Target.activateTarget':
        for (const entry of this.tabs) entry.visible = entry.targetId === params.targetId;
        return {};
      case 'Target.createTarget':
        return { targetId: this.open(String(params.url)).targetId };
      case 'Target.closeTarget': {
        const index = this.tabs.findIndex((entry) => entry.targetId === params.targetId);
        if (index >= 0) this.tabs.splice(index, 1);
        if (this.tabs.length && !this.tabs.some((entry) => entry.visible))
          this.tabs[this.tabs.length - 1]!.visible = true;
        return { success: true };
      }
      case 'Page.enable':
      case 'Page.handleJavaScriptDialog':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'DOM.focus':
      case 'Runtime.callFunctionOn':
        return {};
      case 'Page.getFrameTree': {
        const own = need();
        return { frameTree: { frame: { id: `F-${own.targetId}`, loaderId: own.loaderId, url: own.url } } };
      }
      case 'Page.createIsolatedWorld':
        return { executionContextId: ++this.counter };
      case 'Page.navigate':
        this.navigate(need(), String(params.url));
        return { frameId: `F-${need().targetId}`, loaderId: need().loaderId };
      case 'Page.getNavigationHistory': {
        const own = need();
        return { currentIndex: own.history.length - 1, entries: own.history.map((url, id) => ({ id, url })) };
      }
      case 'Page.navigateToHistoryEntry': {
        const own = need();
        const url = own.history[params.entryId as number]!;
        own.history.splice(params.entryId as number);
        this.navigate(own, url);
        return {};
      }
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
      case 'Page.captureScreenshot':
        return { data: Buffer.from('fake jpeg bytes').toString('base64') };
      case 'Runtime.evaluate':
        return { result: { type: 'object', value: this.evaluate(String(params.expression), need()) } };
      case 'Accessibility.getFullAXTree':
        return { nodes: need().page.ax ?? [] };
      case 'DOM.getContentQuads':
        return { quads: [[10, 10, 30, 10, 30, 20, 10, 20]] };
      case 'DOM.describeNode':
        return { node: { attributes: need().page.attributes?.[params.backendNodeId as number] ?? [] } };
      case 'DOM.resolveNode':
        return { object: { objectId: `O-${params.backendNodeId}` } };
      case 'Input.insertText': {
        const own = need();
        this.typed.push(String(params.text));
        if (own.focused) {
          const list = (own.values[own.focused.field] ??= []);
          list[own.focused.index] = String(params.text);
        }
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        const own = need();
        if (params.type === 'keyDown' || params.type === 'rawKeyDown') {
          this.keys.push(String(params.key));
          if (params.key === 'Enter' && own.page.onEnter) this.navigate(own, own.page.onEnter);
        }
        return {};
      }
      case 'Input.dispatchMouseEvent': {
        const own = need();
        if (params.type === 'mousePressed') {
          this.clicks += 1;
          void this.onClick?.();
          if (own.page.onClick) this.navigate(own, own.page.onClick);
        }
        return {};
      }
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }
}

let nodeCount = 0;

/** A page's accessibility tree from a flat list of (role, name, backend id, value). */
export function axPage(
  title: string,
  items: Array<{ role: string; name: string; node?: number; value?: string }>,
): AxNode[] {
  const root = `ax${++nodeCount}`;
  const children = items.map((item) => ({
    nodeId: `ax${++nodeCount}`,
    parentId: root,
    role: { value: item.role },
    name: { value: item.name },
    ...(item.node !== undefined ? { backendDOMNodeId: item.node } : {}),
    ...(item.value !== undefined ? { value: { value: item.value } } : {}),
  }));
  return [
    {
      nodeId: root,
      role: { value: 'RootWebArea' },
      name: { value: title },
      childIds: children.map((child) => child.nodeId),
    },
    ...children,
  ];
}
