# Greenhouse Bridge — Chrome Web Store submission kit

Everything you need to publish, plus copy you can paste verbatim. Work top to
bottom.

---

## 0. What's already prepared (in the repo)

| Asset | Where | Status |
| --- | --- | --- |
| App icons 16/32/48/128/512 | `apps/browser/public/icons/` (source `assets/icon.svg`) | ✅ done, built into `dist/` |
| 128×128 store icon | `apps/browser/public/icons/icon-128.png` | ✅ done |
| Privacy policy (hosted) | `docs/privacy/index.html` → `https://greenhouse.linjiejim.com/privacy/` | ✅ done — deploys with `docs/` to GitHub Pages |
| Privacy policy (text mirror) | `apps/browser/PRIVACY.md` | ✅ done |
| Listing copy (name/summary/description, EN + ZH) | this file, §3 | ✅ ready to paste |
| Permission justifications | this file, §4 | ✅ ready to paste |
| Data-use answers | this file, §5 | ✅ ready to paste |
| Screenshots (1280×800) | **you capture — see §2** | ⏳ TODO (needs the extension loaded) |

You still need to: **deploy the privacy page, capture 3–5 screenshots, build the
zip, and fill the dashboard forms.**

---

## 1. Deploy the privacy page (do this first)

The page lives under `docs/`, which auto-deploys to GitHub Pages
(`greenhouse.linjiejim.com`). It is a self-contained static file — **no CSS
rebuild needed**.

```bash
git add docs/privacy/index.html
git commit -m "docs: add Greenhouse Bridge privacy policy page"
git push        # to the branch GitHub Pages serves from (main /docs)
```

Then verify it is live: open **https://greenhouse.linjiejim.com/privacy/** in a
browser. You'll paste this exact URL into the store's privacy field (§5).

---

## 2. Capture screenshots (required — at least 1, ideally 3–5)

Chrome Web Store wants **1280×800** (or 640×400) PNG/JPEG. Load the extension
first: `pnpm -F @greenhouse/browser build`, then Chrome → Extensions → Load
unpacked → `apps/browser/dist`, connect it to a Greenhouse instance.

Shot list (each is one screenshot — open the side panel and frame it at
1280×800; the panel is narrow, so capture the panel beside the page it's acting
on):

1. **Ask with page context** — select text on an article, open the panel, ask a
   question; show the answer with the selection-context card.
2. **Browser automation + confirm** — ask it to search something and open a
   result; capture the amber "Assistant wants to act on this page" confirm card
   with the highlighted element behind it.
3. **Permission modes** — open the automation menu (shield icon, left of the
   input) showing Ask / Auto / per-site YOLO.
4. **Save to knowledge** — trigger "Save this page to knowledge"; capture the
   green knowledge confirmation card (title + content preview).
5. **Connect / sign-in** — the options page (server URL + sign-in), to show it's
   self-hosted.

Tip: macOS `⌘⇧4` then space to shoot a window; if it isn't exactly 1280×800,
drop it on a 1280×800 canvas (any image editor, or `sips`/Preview) — the store
letterboxes odd sizes but a clean 1280×800 looks best.

Save them to `apps/browser/store-assets/` (git-ignored is fine; they're only
uploaded to the dashboard).

---

## 3. Listing copy (paste into the dashboard)

**Name**

```
Greenhouse Bridge
```

**Summary** (≤132 chars)

```
Bridge any web page to your self-hosted Greenhouse — ask with page context, automate browsing, and grow your knowledge base.
```

**Category:** Productivity  **Language:** English (add 中文 as a second locale if you want)

**Description (English)**

```
Greenhouse Bridge connects the page you're on to your own self-hosted Greenhouse instance. Sign in with your Greenhouse account (you enter the server URL — there is no third-party service), and the assistant works with your real tools, knowledge, and permissions.

WHAT IT DOES
• Ask with page context — select text on any page and ask about it; the URL, title, and your selection ride along.
• Automate browsing — the assistant can open tabs, read pages, and (with your approval) click and type to carry out tasks like finding and gathering information.
• Grow your knowledge base — save page summaries and findings straight into Greenhouse, always with a confirmation step.
• Your tools, everywhere — the assistant uses exactly the tools your Greenhouse account is allowed, identical to the web app.

YOU'RE IN CONTROL
• Clicks and typing ask for confirmation by default. Switch a site to Auto (only risky actions confirmed) or per-site YOLO (no confirmation) whenever you want.
• Knowledge-base writes always confirm before saving.
• Site access is requested per site, only when you connect or act — never a blanket grant.
• Your password is never stored; only login tokens for the server you chose are kept locally.

SELF-HOSTED, PRIVATE BY DESIGN
Data flows only between your browser and the Greenhouse server you configure. No telemetry, no third-party analytics. Requires your own Greenhouse instance.

Privacy policy: https://greenhouse.linjiejim.com/privacy/
```

**Description (中文, optional second locale)**

```
Greenhouse Bridge 把你正在浏览的网页连接到你自建的 Greenhouse 实例。用你的 Greenhouse 账号登录（服务器地址由你填写，没有任何第三方服务），助手即可使用你真实的工具、知识库与权限。

功能
• 带页面上下文提问 —— 在任意网页选中文本发问，URL、标题与选区一并携带。
• 自动化浏览 —— 助手可以打开标签页、读取网页，并在你批准后点击、输入，完成查资料、收集信息等任务。
• 沉淀知识库 —— 把页面要点与发现直接存入 Greenhouse，每次保存都需确认。
• 工具随账号 —— 助手可用的工具与你的 Greenhouse 账号权限完全一致，和网页端相同。

由你掌控
• 点击与输入默认逐次确认。可将某站点切换为 Auto（仅危险操作确认）或本站 YOLO（不再确认）。
• 知识库写入始终先确认再保存。
• 站点访问按站点、按需申请，绝非一次性全站授权。
• 从不存储密码；仅在本地保存你所选服务器的登录令牌。

自托管，隐私优先
数据仅在你的浏览器与你配置的 Greenhouse 服务器之间流动。无遥测、无第三方分析。需要你自己的 Greenhouse 实例。

隐私政策：https://greenhouse.linjiejim.com/privacy/
```

---

## 4. Permission justifications (the dashboard asks per permission)

Paste each line into its matching field.

- **host permissions / `<all_urls>` (optional, requested at runtime):**
  ```
  Requested per site at runtime (never granted up front) so the assistant can read the user's text selection on the page they choose, and — only for actions the user triggers — read and operate that page. Required for the core "ask with page context" and browser-automation features.
  ```
- **`tabs`:**
  ```
  To list the user's open tabs and open new ones when they ask the assistant to automate a browsing task (e.g. open a search result).
  ```
- **`scripting`:**
  ```
  To run one-shot scripts that read the current page (selection, text, interactive elements) and perform user-approved clicks/typing. No persistent content script runs.
  ```
- **`activeTab`:**
  ```
  To act on the tab the user is currently viewing when they invoke the assistant.
  ```
- **`storage`:**
  ```
  To store the user's chosen server URL, login tokens (not the password), and UI preferences locally.
  ```
- **`sidePanel`:**
  ```
  To present the assistant as a Chrome side panel.
  ```
- **Remote code use:** **No.** All code is bundled in the package; the extension only makes network requests (API calls) to the user's own server.

---

## 5. Privacy practices tab (data-use disclosures)

- **Privacy policy URL:** `https://greenhouse.linjiejim.com/privacy/`
- **Single purpose (required statement):**
  ```
  Greenhouse Bridge lets a user connect the web page they are viewing to their own self-hosted Greenhouse assistant to ask questions with page context, automate browsing tasks, and save content to their knowledge base.
  ```
- **Data collected** — declare these categories and mark **"transferred only to the user's configured server, not sold, not used for unrelated purposes"**:
  - *Website content* — page URL/title/selection/text is sent to the user's server to produce answers.
  - *Authentication information* — email + password are sent to the user's server to log in (password not stored); tokens stored locally.
- **Not collected / not used:** location, health, financial, personal communications for tracking, web-history for ad purposes. **No analytics, no telemetry.**
- Check the three certification boxes (no selling data; no unrelated use; no creditworthiness use) — all true for this extension.

---

## 6. Build the upload zip

```bash
pnpm -F @greenhouse/browser build
cd apps/browser/dist
zip -r ../greenhouse-bridge-v0.1.0.zip .   # zip the CONTENTS of dist/, manifest at the zip root
cd -
```

Verify `manifest.json` sits at the **root** of the zip (not inside a `dist/`
folder). The zip to upload is `apps/browser/greenhouse-bridge-v0.1.0.zip`.

---

## 7. Submit in the dashboard

1. Go to **https://chrome.google.com/webstore/devconsole** and sign in.
2. If it's your first extension, pay the **one-time $5** developer registration
   fee.
3. **New item** → upload the zip from §6.
4. **Store listing** tab: paste Name / Summary / Description (§3), pick category
   Productivity, upload the screenshots (§2) and the 128×128 icon (already in the
   package, but upload `icon-128.png` if it asks for a store icon separately).
5. **Privacy practices** tab: fill §4 (permission justifications) and §5 (data
   use + privacy URL + single-purpose statement).
6. **Distribution:** choose visibility. Recommended first pass — **Unlisted**
   (installable by link, faster to iterate, good for self/team testing), then
   switch to **Public** once you're happy.
7. **Submit for review.** Reviews typically take a few days; an extension with
   `tabs` + broad host access may take longer. You'll get an email on approval or
   with change requests.

---

## 8. Before you go public — recommended (not blocking)

- **HTTPS-only server URLs.** `normalizeBaseUrl` (`src/lib/auth.ts`) currently
  accepts `http://`. For a public release, warn on or reject non-localhost
  `http://` so login tokens aren't sent in clear text. (Left as-is for now
  because it affects local dev; decide before Public.)
- **Version bump discipline.** Each store update needs a higher `version` in
  `public/manifest.json`.
- **Keep the two privacy copies in sync** (`docs/privacy/index.html` and
  `apps/browser/PRIVACY.md`) if you change anything.

---

## Common rejection reasons (all pre-addressed here)

- Missing / unreachable privacy policy → hosted at a stable URL (§1).
- Unjustified permissions → each justified (§4), and none unused.
- Requesting broad host access without explanation → it's `optional` +
  runtime-requested, explained in §4.
- Data-use form incomplete → §5 covers every field.
