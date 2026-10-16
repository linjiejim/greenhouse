/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../Markdown';

const render = (text: string) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Markdown text={text} />);
  return host;
};

describe('reply Markdown', () => {
  it('keeps single tildes in ranges and prose, and strikes only double tildes', () => {
    const host = render('19~24°C，明天 20~25°C；~原文~，~~删除 **强调**~~');
    expect(host.querySelectorAll('del')).toHaveLength(1);
    expect(host.querySelector('del')?.textContent).toBe('删除 强调');
    expect(host.querySelector('del strong')?.textContent).toBe('强调');
    expect(host.textContent).toContain('19~24°C，明天 20~25°C；~原文~');
  });

  it('preserves escaped tildes, code and GFM tables', () => {
    const host = render('`~~code~~` \\~\\~literal\\~\\~\n\n| Range |\n| --- |\n| 19~24°C |');
    expect(host.querySelector('code')?.textContent).toBe('~~code~~');
    expect(host.querySelector('td')?.textContent).toBe('19~24°C');
    expect(host.querySelector('del')).toBeNull();
  });
});
