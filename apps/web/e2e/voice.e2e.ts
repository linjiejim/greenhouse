import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiAs } from './api';
import { E2E } from './env';
import { composer, open } from './fixtures';

/**
 * 语音 (CONV-12, CONV-13): the microphone and read-aloud, through the speech services when one
 * is set up (the fake server answers like OpenAI's), else the browser's own recognition and voice,
 * else neither is offered. Chromium's fake microphone plays a tone.
 */

const SPOKEN = '帮我把本周进度整理成周报';

/** A workspace speech service on the fake server, for the length of one test. */
async function service(request: APIRequestContext, capability: 'stt' | 'tts') {
  const made = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/admin/providers', {
    capability,
    kind: 'openai-compatible',
    name: capability === 'stt' ? 'Fake transcription' : 'Fake speech',
    config:
      capability === 'stt'
        ? { baseUrl: `http://127.0.0.1:${E2E.llmPort}/v1`, model: 'fake-stt' }
        : { baseUrl: `http://127.0.0.1:${E2E.llmPort}/v1`, model: 'fake-tts', voice: 'alloy' },
  });
  return () => apiAs(request, 'lin', 'DELETE', `/api/admin/providers/${made.id}`);
}

/** The browser's own recognition, scripted: it hears `words` and ends when asked to. */
const fakeRecognition = (words: string) => `
  class FakeRecognition {
    start() {
      setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: ${JSON.stringify(words)} }], { isFinal: true })] }), 200);
    }
    stop() { setTimeout(() => this.onend?.(), 50); }
    abort() { setTimeout(() => this.onend?.(), 10); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
`;

/** The browser's own voice, recorded: what it was asked to say goes into window.__spoken. */
const fakeVoice = `
  window.__spoken = [];
  const synth = {
    speak(utterance) { window.__spoken.push(utterance.text); this.timer = setTimeout(() => utterance.onend?.(), 2000); },
    cancel() { clearTimeout(this.timer); },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
`;

const noBrowserSpeech = `
  Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
`;

/** The fake model's reply to `said` ("Echo: …"), found by how it reads on the page. */
async function reply(page: Page, said: string, shown: string) {
  await composer(page).fill(said);
  await composer(page).press('Enter');
  const message = page.locator('.app-message', { hasText: `Echo: ${shown}` });
  await expect(message.getByRole('button', { name: '复制' })).toBeAttached();
  return message;
}

test('the microphone records with its levels and time; the words land in the composer and are not sent', async ({
  page,
  request,
}) => {
  const done = await service(request, 'stt');
  try {
    await open(page);
    await composer(page).fill('Hi ');
    await page.getByRole('button', { name: '语音输入' }).click();
    await expect(page.getByText('正在听… 再点麦克风结束，Esc 取消')).toBeVisible();
    await expect(page.locator('.app-recording-time')).toHaveText(/^0:0[1-9]$/);
    // The fake microphone's tone moves the meter.
    await expect
      .poll(() =>
        page
          .locator('.app-recording-bars i')
          .evaluateAll((bars) =>
            Math.max(...bars.map((bar) => Number(getComputedStyle(bar).getPropertyValue('--level')) || 0)),
          ),
      )
      .toBeGreaterThan(0);
    const sent = page.waitForRequest((asked) => asked.url().endsWith('/api/voice/transcriptions'));
    await page.getByRole('button', { name: '结束录音' }).click();
    const upload = await sent;
    expect(upload.headers()['content-type']).toContain('multipart/form-data');
    await expect(composer(page)).toHaveValue(`Hi ${SPOKEN}`);
    await expect(composer(page)).toBeFocused();
    // Nothing went out: the member reviews it first.
    await expect(page.getByText(`Echo: Hi ${SPOKEN}`)).toHaveCount(0);

    // Esc cancels, and what was typed stays as it was.
    let asked = 0;
    page.on('request', (seen) => seen.url().endsWith('/api/voice/transcriptions') && asked++);
    await page.getByRole('button', { name: '语音输入' }).click();
    await expect(page.locator('.app-recording')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.app-recording')).toHaveCount(0);
    await expect(composer(page)).toHaveValue(`Hi ${SPOKEN}`);
    expect(asked).toBe(0);
  } finally {
    await done();
  }
});

test('a microphone the browser refuses says how to allow it', async ({ page, request }) => {
  const done = await service(request, 'stt');
  try {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await open(page);
    await page.getByRole('button', { name: '语音输入' }).click();
    await expect(page.getByRole('alert')).toHaveText('没有麦克风权限：在浏览器的网站设置里允许使用麦克风后再试');
    await expect(page.locator('.app-recording')).toHaveCount(0);
  } finally {
    await done();
  }
});

test('without a speech service the browser recognizes the words, and with neither there is no microphone', async ({
  page,
  browser,
}) => {
  await page.addInitScript(fakeRecognition('浏览器听到的话'));
  await open(page);
  await page.getByRole('button', { name: '语音输入' }).click();
  await expect(page.locator('.app-recording')).toContainText('浏览器听到的话');
  await page.getByRole('button', { name: '结束录音' }).click();
  await expect(composer(page)).toHaveValue('浏览器听到的话');

  const context = await browser.newContext({ storageState: 'e2e/.auth/lin.json', locale: 'zh-CN' });
  const bare = await context.newPage();
  await bare.addInitScript(noBrowserSpeech);
  await open(bare);
  await expect(composer(bare)).toBeVisible();
  await expect(bare.getByRole('button', { name: '语音输入' })).toHaveCount(0);
  await context.close();
});

test('read-aloud through the speech service says the prose only, one reply at a time', async ({ page, request }) => {
  const done = await service(request, 'tts');
  try {
    await open(page, '/#/c/new');
    const first = await reply(page, '看 **这里** 和 `代码`', '看 这里 和 代码');
    const second = await reply(page, '第二条', '第二条');
    const asked = page.waitForRequest((seen) => seen.url().endsWith('/api/voice/speech'));
    await first.hover();
    await first.getByRole('button', { name: '朗读' }).click();
    expect((await asked).postDataJSON()).toEqual({ text: 'Echo: 看 这里 和 代码' });
    await expect(first.getByRole('button', { name: '停止朗读' })).toHaveAttribute('aria-pressed', 'true');

    // Another reply takes over: the first one stops.
    await second.hover();
    await second.getByRole('button', { name: '朗读' }).click();
    await expect(second.getByRole('button', { name: '停止朗读' })).toBeVisible();
    await expect(first.getByRole('button', { name: '朗读' })).toHaveAttribute('aria-pressed', 'false');
    await second.getByRole('button', { name: '停止朗读' }).click();
    await expect(second.getByRole('button', { name: '朗读' })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await done();
  }
});

test('without a speech service the browser reads aloud, and with no voice at all there is no read-aloud', async ({
  page,
  browser,
}) => {
  await page.addInitScript(fakeVoice);
  await open(page, '/#/c/new');
  const message = await reply(page, '**你好**，世界', '你好，世界');
  await message.hover();
  await message.getByRole('button', { name: '朗读' }).click();
  await expect(message.getByRole('button', { name: '停止朗读' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual([
    'Echo: 你好，世界',
  ]);
  await message.getByRole('button', { name: '停止朗读' }).click();
  await expect(message.getByRole('button', { name: '朗读' })).toBeVisible();

  const context = await browser.newContext({ storageState: 'e2e/.auth/lin.json', locale: 'zh-CN' });
  const bare = await context.newPage();
  await bare.addInitScript(noBrowserSpeech);
  await open(bare, '/#/c/new');
  const silent = await reply(bare, 'quiet please', 'quiet please');
  await expect(silent.getByRole('button', { name: '朗读' })).toHaveCount(0);
  await context.close();
});
