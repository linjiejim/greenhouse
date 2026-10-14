# 服务 Provider 体系

更新 2026-10-14 · 状态：设计已定，大部分已实现（[功能清单](features.md) PRV-01…16）· 配套 [PRD §8.1](prd.md#81-服务provider)

## 1. 目标

- 能力和厂商解耦。 9 类外部能力都可以换厂商；业务代码只依赖能力接口，不出现厂商名。
- 两种配置入口。 部署时用环境变量初始化；运行时由管理员在界面上改，改完立即生效，不需要重启。
- 个人 Key。 管理员允许时，成员可以用自己的 Key，用量记在自己名下。
- 兼容主流厂商。 优先按协议适配，国内外主流厂商都用「预设」覆盖。
- 安全默认。 Key 只写不读，只发往它配置的地址；成员自填的地址不能访问内网。

不做：运行时插件 ABI（适配器随代码或扩展发布）；按请求临时传 Key 的接口。

仓库规则「没有第二个消费者，就不写多后端抽象」在这里成立：v2.0 每类能力至少上线两个真实适配器（见 §6）。

## 2. 能力

| 能力 | ID | 消费方 | 没有任何可用 Provider 时 |
| --- | --- | --- | --- |
| 大模型 | `llm` | 对话、运行、标题、摘要、记忆整理；`vision` 模型读图 | 启动后引导管理员配置；对话不可用 |
| 语音输入 | `stt` | 输入框麦克风；音频附件转写 | 退回到客户端识别（浏览器 Web Speech、iOS Speech），仍不支持则隐藏麦克风 |
| 语音输出 | `tts` | 消息「朗读」；`speak` 工具生成音频文件 | 退回到客户端朗读（浏览器 `speechSynthesis`、iOS AVSpeech），工具不提供 |
| 图像 | `image` | `generate_image`（生成、参考图编辑） | 工具不提供，界面不提及 |
| 视频 | `video` | `generate_video`（异步任务） | 同上 |
| 沙箱 | `sandbox` | Agent 电脑、长时间运行、`compute` 之外的命令执行 | 隐藏电脑相关入口；后台运行只用无沙箱工具 |
| 搜索 | `search` | `web_search`；`web_fetch`（网页读取） | 工具不提供；`web_fetch` 退回到内置的安全抓取 |
| 存储 | `storage` | 所有文件：上传、附件、产物、导出、技能包、电脑备份 | 本地磁盘 `data/` |
| 邮箱 | `mail` | 系统发信（邀请、重置密码、通知邮件）；Agent 邮箱的收信与发信 | 不发邮件：邀请与重置改为复制链接；Agent 没有邮箱；邮件通知不出现 |

渠道也是 Provider，和上面 9 类用同一张表、同一套解析与安全规则，在「管理 → 服务」里配置：

| 能力 | ID | 消费方 | 未配置时 |
| --- | --- | --- | --- |
| 即时通讯 | `im` | 飞书、企微：通知送达。v2.0 不在界面出现，以后和 Slack、Discord、Telegram 一起作为 IM 渠道统一设计（账号、机器人、送达、扫码登录） | 对应登录与渠道不出现 |
| 推送 | `push` | 手机推送（Expo 推送服务，它替官方 App 持有 APNs / FCM 凭据） | 不推送，只有站内通知 |

渠道和 9 类能力有三处不同：
- 一个渠道由同类实例（`feishu`、`wecom`、`expo`）在工作区顺序里的第一个提供，不回退到第二个：渠道关了就是关了。邮件通知走邮箱能力（`mail`），按能力的顺序回退。飞书和企微同属 `im`，按类型各取各的。
- 「管理 → 服务 → 渠道」（`/api/admin/channels`）按渠道编辑：第一次保存生成工作区实例，环境变量来的设置先复制成可编辑的一份，再排到同类之首。
- 渠道发送不计量，也不受预算限制：一封「需要你」的邮件不能因为模型预算用完而发不出去。

以后可能加的能力：`embedding`（知识库语义检索；v1 明确用全文检索，暂不需要）。

## 3. 概念

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| 适配器 Adapter（`kind`） | 一种协议或厂商 API 的实现 | `openai-compatible`、`anthropic`、`gemini`、`s3`、`tavily` |
| 预设 Preset | 某个厂商在适配器上的默认值：base URL、默认模型、文档链接 | DeepSeek、Kimi、通义千问、豆包都走 `openai-compatible`；腾讯 COS 走 `s3` |
| 实例 Instance | 一份可用的配置：适配器、预设、参数、加密机密 | 「公司 DeepSeek」「张三的 OpenAI Key」 |
| 绑定 Binding | 一个能力用哪些实例：有序，第一个出错时依次回退 | `llm: [公司 DeepSeek, 公司 Qwen]` |
| 默认项 Defaults | 绑定上的默认选择 | 默认模型、强模型、快模型、默认音色、图片尺寸 |
| 策略 Policy | 每个能力是否允许个人 Key，以及个人用量是否计入组织预算 | `stt: allowPersonal = true` |
| 来源 Source | 实例从哪里来 | `env`（只读）、`workspace`（数据库）、`personal`、`builtin` |

## 4. 配置与解析

### 4.1 优先级

某个成员使用能力 C 时，按下面的顺序选择，用到第一个可用的为止：

1. 个人实例：C 的策略允许个人 Key，且该成员为 C 启用了个人实例。公开 Agent 和别人发起的运行不用个人实例。
2. 工作区绑定：数据库里 C 的有序实例。空列表表示停用 C，环境变量实例也不用。
3. 还没有保存绑定时：先环境变量实例（按声明顺序），再工作区实例（按添加顺序）。
4. 内置默认：存储用本地磁盘；STT / TTS 退回客户端；其余能力视为不可用。

- 已保存绑定时，新加的工作区实例自动排到末尾。
- 停用的实例、缺少必填 Key 的实例不参与解析。
- 每次解析都读取当前配置，改动立即生效，没有缓存。将来加缓存时按 `provider_bindings.version` 失效。v1 那种「把数据库值回写到 `process.env`」的做法不再使用。

### 4.2 环境变量：简单形式

每个能力一组变量，覆盖最常见的单厂商部署：

```bash
# 大模型：PROVIDER 写适配器或预设名
LLM_PROVIDER=deepseek            # openai | anthropic | gemini | openai-compatible | deepseek | kimi | qwen | doubao | glm | minimax | siliconflow | openrouter | ollama …
LLM_API_KEY=sk-…
LLM_BASE_URL=                    # 留空 = 预设地址；填写后这个 Key 只会发往这里；只填它不填 PROVIDER 时按 openai-compatible
LLM_MODEL=deepseek-chat          # 默认模型
LLM_MODEL_STRONG=deepseek-reasoner   # 可选
LLM_MODEL_FAST=                  # 可选，用于标题、摘要；为空时用默认模型

STT_PROVIDER=openai-compatible   STT_API_KEY=…  STT_BASE_URL=…  STT_MODEL=whisper-1
TTS_PROVIDER=minimax             TTS_API_KEY=…  TTS_VOICE=female-shaonv
IMAGE_PROVIDER=openai            IMAGE_API_KEY=…  IMAGE_MODEL=gpt-image-1
VIDEO_PROVIDER=kling             VIDEO_API_KEY=…  VIDEO_SECRET=…
SANDBOX_PROVIDER=docker          # docker | e2b | ppio（e2b 的预设）
SANDBOX_IMAGE=greenhouse/computer:latest  SANDBOX_DOCKER_RUNTIME=runsc   # runsc = gVisor，生产必须；runc 只用于开发
SANDBOX_NETWORK=bridge  SANDBOX_MEMORY=2g  SANDBOX_CPUS=2
SANDBOX_API_KEY=e2b_…  SANDBOX_E2B_TEMPLATE=gh-computer-…   # e2b：模板名由 scripts/e2b-template.mts 构建后给出
SANDBOX_E2B_DOMAIN=  SANDBOX_E2B_NAMESPACE=greenhouse  SANDBOX_E2B_TIMEOUT_MINUTES=60   # domain 留空 = 预设的
SEARCH_PROVIDER=tavily,brave     # 多个用逗号分隔，就是回退顺序
TAVILY_API_KEY=…  BRAVE_API_KEY=…
STORAGE_PROVIDER=s3              # local | s3
STORAGE_ENDPOINT=https://cos.ap-shanghai.myqcloud.com  STORAGE_BUCKET=…  STORAGE_REGION=ap-shanghai
STORAGE_ACCESS_KEY_ID=…  STORAGE_SECRET_ACCESS_KEY=…  STORAGE_PREFIX=greenhouse/  STORAGE_FORCE_PATH_STYLE=false

# 邮箱：系统发信与 Agent 邮箱；设置不全时启动告警并忽略。顺序固定：Resend、Mailgun、SMTP（能收信的在前）
MAIL_FROM="Greenhouse <greenhouse@example.com>"   # 系统邮件的发件人；Resend、Mailgun 必填，SMTP 没有 SMTP_FROM 时也用它
RESEND_API_KEY=re_…  RESEND_WEBHOOK_SECRET=whsec_…   # 有 webhook 密钥才收信；RESEND_BASE_URL 留空 = api.resend.com
MAILGUN_API_KEY=…  MAILGUN_WEBHOOK_SIGNING_KEY=…  MAILGUN_DOMAIN=agents.example.com  MAILGUN_REGION=us   # us | eu；有签名密钥才收信
SMTP_HOST=smtp.example.com       SMTP_SECURITY=starttls   # tls | starttls（默认）| none；SMTP_PORT 默认 465 / 587 / 25；只发
SMTP_USER=…  SMTP_PASSWORD=…  SMTP_FROM=greenhouse@example.com  SMTP_FROM_NAME=Greenhouse
MAIL_AGENT_DOMAIN=agents.example.com   # Agent 邮箱的域名；MX 指向能收信的服务；管理界面保存后以界面为准

# 渠道（通知送达）；设置不全的渠道启动时告警并忽略
FEISHU_APP_ID=cli_…  FEISHU_APP_SECRET=…  FEISHU_BASE_URL=   # 留空 = open.feishu.cn；Lark 填 https://open.larksuite.com
WECOM_CORP_ID=ww…  WECOM_AGENT_ID=1000002  WECOM_APP_SECRET=…  WECOM_BASE_URL=   # 留空 = qyapi.weixin.qq.com
PUSH_PROVIDER=expo               EXPO_ACCESS_TOKEN=        # 只有 Expo 项目开了 enhanced push security 才要
```

### 4.3 环境变量：文件形式

`PROVIDERS_FILE=/config/providers.yaml` 用来声明多实例、回退链和模型目录，取代 v1 的 `models.yaml`。机密只写引用的环境变量名：

```yaml
llm:
  - id: corp-deepseek
    kind: openai-compatible
    preset: deepseek
    api_key_env: DEEPSEEK_API_KEY
    models:
      - { id: deepseek-chat, context_window: 128000, tools: true }
      - { id: deepseek-reasoner, context_window: 128000, reasoning: true }
  - id: corp-claude
    kind: anthropic
    api_key_env: ANTHROPIC_API_KEY
    models: [{ id: claude-sonnet-4-5, vision: true, context_window: 200000 }]
defaults:
  llm: { default: corp-deepseek/deepseek-chat, strong: corp-claude/claude-sonnet-4-5 }
policy:
  stt: { allow_personal: true }
```

### 4.4 运行时（数据库）

| 表 | 字段 |
| --- | --- |
| `providers` | `id`、`capability`、`kind`、`preset`、`name`、`scope`（`workspace` / `personal`）、`owner_id`、`config`（jsonb，非机密）、`secrets_enc`（AES-256-GCM，用 `PROVIDER_TOKEN_ENCRYPTION_KEY`）、`enabled`、`last_check`（时间、结果、耗时）、`created_by`、时间戳 |
| `provider_bindings` | `capability`（主键）、`instance_ids`（有序）、`defaults`（jsonb）、`policy`（jsonb）、`version` |

- 环境变量实例只在内存里，界面上标「来自环境变量」，只读。管理员可以在绑定里停用它，或「复制为可编辑」：生成一个数据库实例，它在顺序和默认项里替换原来的环境变量实例。
- 修改 `base_url` 时清空已存的机密，必须重新填写 Key。

### 4.5 模型引用

- Agent、定时和工具引用模型的格式是 `实例/模型`，例如 `corp-claude/claude-sonnet-4-5`；或者用别名 `default`、`strong`、`fast`。
- Agent 默认跟随 `default`。只有工作区可选的模型多于一个时，界面才出现模型选择。
- 系统内部任务（标题、摘要、记忆整理）只用 `fast` 别名，不再写死模型 id（修复 v1 写死 `flash` / `pro` 的问题）。

## 5. 接口（`packages/providers`）

```ts
export type Capability = 'llm' | 'stt' | 'tts' | 'image' | 'video' | 'sandbox' | 'search' | 'storage';

export interface ProviderAdapter<C extends Capability, Config> {
  capability: C;
  kind: string;                              // 'openai-compatible' | 'anthropic' | 's3' | …
  label: string;
  configSchema: z.ZodType<Config>;           // 非机密字段，界面表单由它生成
  secretKeys: readonly string[];             // 例如 ['apiKey']，界面只写不读
  presets?: readonly ProviderPreset<Config>[];
  create(input: { config: Config; secrets: Record<string, string>; ctx: ProviderContext }): ClientOf<C>;
  test?(client: ClientOf<C>): Promise<ProviderCheck>;   // 「测试连接」用最便宜的一次调用
}

interface LlmClient     { model(id: string): LanguageModel; listModels?(): Promise<ModelInfo[]> }   // LanguageModel 来自 AI SDK
interface SttClient     { transcribe(i: { audio: Blob; mimeType: string; language?: string; prompt?: string }): Promise<Transcript> }
interface TtsClient     { synthesize(i: { text: string; voice?: string; format?: AudioFormat; speed?: number }): Promise<AudioResult>; voices?(): Promise<Voice[]> }
interface ImageClient   { generate(i: { prompt: string; size?: string; n?: number; references?: FileRef[]; mask?: FileRef }): Promise<MediaResult> }
interface VideoClient   { submit(i: { prompt: string; seconds?: number; aspect?: string; image?: FileRef }): Promise<{ jobId: string }>; poll(jobId: string): Promise<VideoJob> }
interface SandboxClient { ensure(s: SandboxSpec); status(name); exec(name, i); stream(name, i); screen(name); devtools(name); stop(name); restart(name); remove(name, { keepHome }) }   // 由 v1 的 ComputerHost 泛化
interface SearchClient  { search(q: string, o?: SearchOptions): Promise<SearchResult[]>; fetch?(url: string): Promise<PageContent> }
interface StorageClient { put(key: string, body: Body, o?: PutOptions): Promise<void>; get(key: string): Promise<ReadableStream>; head(key: string): Promise<ObjectInfo | null>; delete(key: string): Promise<void>; presign?(key: string, o: PresignOptions): Promise<string> }
```

服务端的解析入口只有一个：

```ts
const { client, instance, source } = await providers.resolve('tts', { userId, agentId, purpose: 'read-aloud' });
```

- LLM 的回退链复用 v1 的 `ProviderAttemptHook`：每次具体尝试前预留预算，遇到 429、5xx 或网络错误时换下一个实例。
- 每次调用都写一条用量记录（§8）。
- 厂商特有的行为（例如 DeepSeek 的 thinking、提示缓存）只能写在对应的适配器和预设里，业务代码里不出现。

## 6. 主流厂商覆盖

实现优先复用已经在用的 Vercel AI SDK provider 包；国内厂商多数走 OpenAI 兼容协议，加上预设即可。

v2.0 表示首发；后续 表示接口已经留好，按需求再加。

### 大模型 `llm`

| 适配器 | v2.0 预设 / 覆盖 | 后续 |
| --- | --- | --- |
| `openai` | OpenAI（Responses 与 Chat Completions） | Azure OpenAI |
| `anthropic` | Anthropic Claude；Anthropic 兼容端点（DeepSeek、Kimi、智谱） | AWS Bedrock |
| `gemini` | Google Gemini（AI Studio） | Vertex AI |
| `openai-compatible` | DeepSeek、Kimi、通义千问（百炼）、豆包（火山方舟）、智谱 GLM、MiniMax、阶跃星辰、硅基流动、OpenRouter、Groq、xAI、Mistral、Together；本地 Ollama、vLLM、LM Studio、LiteLLM | 百度千帆、腾讯混元 |

### 语音输入 `stt`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `openai-compatible`（`/audio/transcriptions`） | OpenAI（whisper-1、gpt-4o-transcribe）、Groq、硅基流动（SenseVoice）、本地 faster-whisper / speaches | — |
| `aliyun` | 阿里云百炼（Paraformer、Qwen-ASR） | — |
| `deepgram` | Deepgram Nova | — |
| 客户端回退 | 浏览器 Web Speech、iOS Speech | 火山引擎、腾讯云、讯飞、Azure、Google、ElevenLabs Scribe、AssemblyAI |

### 语音输出 `tts`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `openai-compatible`（`/audio/speech`） | OpenAI（gpt-4o-mini-tts）、硅基流动（CosyVoice）、本地 Kokoro | — |
| `elevenlabs` | ElevenLabs | — |
| `minimax` | MiniMax Speech | — |
| `aliyun` | 百炼 CosyVoice、Qwen-TTS | — |
| 客户端回退 | 浏览器 `speechSynthesis`、iOS AVSpeech | 火山引擎、Azure、Google、Fish Audio、Cartesia |

### 图像 `image`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `openai-compatible`（Images API） | OpenAI gpt-image、302.AI 等聚合、硅基流动、Together | — |
| `gemini` | Imagen、Gemini Image | — |
| `aliyun` | 通义万相、Qwen-Image | — |
| `volcengine` | 豆包 Seedream | Black Forest Labs FLUX、Stability、Ideogram、Recraft、智谱 CogView、Replicate、fal |

### 视频 `video`（全部是异步任务）

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `openai` | Sora 2 | — |
| `gemini` | Veo 3 | — |
| `kling` | 可灵 | — |
| `aliyun` | 通义万相 Wan | — |
| `volcengine` | Seedance | — |
| `minimax` | 海螺 | Runway、Luma、Vidu、Replicate、fal |

### 沙箱 `sandbox`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `docker` | 本机 Docker + gVisor（`runsc`） | — |
| `e2b` | E2B；PPIO（预设）；其他 E2B 协议兼容服务填写 domain，须支持暂停与恢复 | Daytona、Modal、Kubernetes |

E2B 与兼容服务（`packages/providers/src/sandbox/e2b/`，从 v1 移植）：

- 每台电脑是服务商的一台微虚拟机，从 apps/bot-computer 构建的模板启动。`scripts/e2b-template.mts` 在服务商处构建模板并给出名字；名字随内容变化，镜像改了就重新构建、改配置。CPU 与内存在构建模板时决定，创建接口没有按台的规格。
- 电脑按名字找：沙箱元数据里的命名空间 `gh_ns` 与名字 `gh_name`。同一个账号下的另一个部署（例如恢复出来的副本）要换命名空间。
- 停止就是暂停：内存与磁盘都保留，下次启动约一秒恢复，家目录和所有进程（后台任务也在内）接着跑。没有单独的卷，暂停的沙箱就是家目录；重置（`keepHome: false`）销毁沙箱，家目录一起删除。E2B 与 PPIO 都会一直保留暂停的沙箱，直到删除。
- 超时兜底：API 不再触达后 `timeoutMinutes`（默认 60）分钟，运行中的电脑自动暂停，从不销毁；服务商声明超时会销毁的，电脑不启用。使用时每 5 分钟续期一次，开着的画面和终端也续期。它要大于闲置分钟数。
- 重启在原地进行：结束 agent 与 browser 两个账号的全部进程，清掉它们留在临时目录里的文件，再启动桌面；家目录保留。
- 端口全部私有：创建时关闭公开访问，服务商的边缘只放行带这台沙箱流量 token 的请求；没有给 token 的服务商不启用。两个桥（gh-bridge）再各自校验本账号的密钥（API Key 对沙箱与账号的 HMAC）：browser 账号的桥管画面与 DevTools，agent 账号的桥管命令、终端与文件。VNC 与 DevTools 仍是 browser 账号 0600 的 Unix socket，只有它的桥能打开。
- envd（服务商在沙箱里的代理）只做 root 的事：出口规则、启动脚本、重启、以 root 执行的命令。命令的时限在电脑里执行（`timeout`），API 另有兜底。
- 出口：每次启动以 root 加载 nftables 规则，只管两个成员账号：不能访问链路本地网段（含元数据服务 169.254.169.254）、私网与保留网段、envd 与两个桥的端口；外网和 DNS 照常。新沙箱另由服务商在虚拟机外拒绝私网。规则加载后从两个账号各探测一次，有一个目标能连通，这台电脑就不启用。
- API Key 只发往 `https://api.<domain>`；envd 与两个桥在 `<端口>-<沙箱>.<domain>`，各用自己的 token，固定 fetch 只放行这个域名下的地址。
- 模板升级不搬家：已有的电脑继续用创建时的模板，新电脑用配置的模板。

### 搜索 `search`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| 各自独立的适配器 | Tavily、Brave、Exa、Jina（搜索与 Reader）、Firecrawl、SearXNG（自托管）、博查 | Serper、SerpAPI、Perplexity、秘塔、模型自带搜索 |
| 网页读取 `fetch` | 内置安全抓取（SSRF 防护）、Jina Reader、Firecrawl | — |

v1 的 Jina Reader 写死、不能关闭；v2 把它变成可选项。

### 存储 `storage`

| 适配器 | v2.0 | 后续 |
| --- | --- | --- |
| `local` | 本地磁盘 | — |
| `s3` | AWS S3、Cloudflare R2、MinIO、腾讯 COS、阿里 OSS、华为 OBS、七牛、Backblaze B2 | Azure Blob、GCS 原生 |

v2 的存储层统一为一个接口：v1 的 COS SDK、`s3-lite`、技能存储和电脑备份四套实现合并。表结构里的厂商字段（如 `cos_key`）改为中性的 `storage_key`。

### 邮箱 `mail`

| 适配器 | v2.0 | 说明 |
| --- | --- | --- |
| `smtp` | 只发 | 任意 SMTP 服务器（tls / starttls / none）；nodemailer，写在 API 里（`apps/api/src/modules/mail/smtp.ts`），像扩展一样注册；换地址清空密码 |
| `resend` | 收发 | 发信：`POST /emails`。收信：`email.received` webhook（Svix 签名，覆盖原始请求体，5 分钟内有效）只当通知；信和收信服务器算出的 SPF / DKIM / DMARC 结论用 Key 从接收 API（`/emails/receiving/:id`）拉取，附件从 Resend 的签名链接下载（`inbound-cdn.resend.com`，不带 Key） |
| `mailgun` | 收发 | 发信：`POST /v3/<domain>/messages`。收信：Route 的 `store(notify=…)` 通知，签名是时间戳加令牌的 HMAC（12 小时内有效，令牌只用一次）；签名不覆盖通知里的其他字段，所以只取 `message-url`，它必须是本实例域名在 Mailgun 存储地址上的信，再用 Key 拉取；Mailgun 加的 `X-Mailgun-Spf`、`X-Mailgun-Dkim-Check-Result` 各出现一次才算数（发件人能在信里写同名的头） |

- 不选 Postmark：它的入站 webhook 不签名，只能靠 URL 里的基本认证和 IP 名单。
- 实例配一个系统发件人（`fromAddress`、`fromName`）；Agent 的信从它自己的地址发出。
- 能收信的适配器声明收信密钥（`receiveSecret`），实例填了它才收信。入站地址是 `/api/mail/inbound/<实例 id>`（公开）：先验签，验签失败、过期或格式不对一律 401；验签前按服务商的上限拒收过大的请求（Resend 256 KB，Mailgun 40 MB）。
- 通知只是「去取」的信号：信从服务商 API 拉取，解析成统一的邮件（发件人、收件人、抄送、Reply-To、信封收件人与发件人、主题、正文、HTML、附件、Message-ID、In-Reply-To、References、SPF / DKIM / DMARC 结论、DKIM 签名域）。伪造的通知取不到不存在的信；Key 只发往本实例的地址（`pinnedFetch`），通知里的地址指向别处时不发请求。
- 一次性：通知的 nonce（Svix 的 id、Mailgun 的令牌）成功处理后记在 `idempotency_keys`（scope `mail_notice`）；同一封信按「Agent、实例、服务商的信 id」只存一次。处理失败（拉信失败）返回 502，由服务商重试。
- 上限：主题 500 字，纯文本 20 万字，HTML 2 MB（超出只留纯文本），附件单个 15 MB、合计 25 MB、最多 20 个，超出的记下名字和原因、不下载。
- Agent 邮箱的域名由 `MAIL_AGENT_DOMAIN` 或「管理 → 服务 → 邮箱」设置，MX 记录指向服务商；地址默认是「名字-随机 4 位@域名」，主人可以改前缀；保留 postmaster、abuse 等名字和系统发件人的名字。
- 来信是不可信输入：HTML 正文和附件存进存储服务（文件用途 `mail`，属于 Agent 的主人），纯文本留在库里供阅读和搜索；Agent 读到的正文用 fence 隔开。
- 只有能收信的实例在顺序之首、且设了域名时，Agent 邮箱才出现。系统发信与 Agent 发信都按顺序回退。

### 渠道 `im` / `push`

| 能力 | 适配器 | v2.0 | 后续 |
| --- | --- | --- | --- |
| `im` | `feishu`、`wecom` | 代码已有、界面不出现：飞书（含 Lark 预设）与企微自建应用，纯文本私信；令牌按应用缓存 | IM 渠道统一设计：加 Slack、Discord、Telegram，账号绑定、机器人、扫码登录 |
| `push` | `expo` | Expo 推送服务：按项目分组、每次最多 100 条，15 分钟后查回执 | 直连 APNs / FCM |

## 7. 界面

管理 → 服务

- 9 行能力加 1 行推送，每行显示：能力名、浅色「?」（能力用在哪里）、当前实例与来源标签、状态点、「配置」。`im` 在 IM 渠道之前不出现。
- 点「配置」在右侧抽屉里管理这个能力：
  - 实例列表：可以拖动排序，顺序就是回退顺序。
  - 添加实例：先选厂商预设；表单由 `configSchema` 生成，Key 只写不读。
  - 测试连接：显示耗时和返回的错误原文。
  - 默认项：模型、音色、尺寸。
  - 策略：一个开关「允许成员使用自己的 Key」。
- 沙箱的抽屉里额外有：电脑容量（空闲分钟数、最大并发）、电脑列表（停止、重置、备份）。
- 邮箱的抽屉里额外有：Agent 邮箱的域名、每个能收信的实例要填到服务商那里的入站地址、「发测试邮件给我」。
- 初次部署没有可用 LLM 时，登录后直接进入这一页。

设置 → 我的服务

- 只列出允许个人 Key 的能力。
- 每个能力可以添加自己的实例、测试、删除，并显示当前生效的是「我的 Key」还是「工作区」。

其他界面

能力不可用时，界面上不出现相关入口。如果某个入口只缺权限，就保留它，并用「?」说明原因。

## 8. 用量与预算

- 每次调用写一条 `usage_events`：
  - 主体：能力、实例、来源、成员、Agent、运行、对话。
  - 计量单位：LLM 是输入、输出与缓存 token；STT 是音频秒数；TTS 是字符数；图像是张数；视频是秒数；沙箱是运行分钟；存储是字节数。
  - 预估费用：模型的单价写在实例的模型目录里（`price`：输入、输出、缓存输入，美元 / 百万 token），管理员可以改；没有单价的调用费用未知，界面上单独计数。预设暂不带单价。
- 预算有三级：组织、服务实例、成员，单位是 token 或美元，按 UTC 自然月。用个人 Key 产生的用量默认不计入组织和成员预算，由策略决定；服务实例的预算计入它服务的全部调用。
- 每次调用前（模型的每次尝试也算）检查覆盖它的预算，已用完就拒绝（`budget_exceeded`）；某个实例自己的预算用完时，回退到下一个实例。已用量直接汇总当月的 `usage_events`，正在进行的调用可能略微超出。
- 公开 Agent 的回合记在提问的成员名下，计入这位成员的预算和组织预算；发布设置另有每人每日上限。
- v1 的约 8 个用量接口合并为两个：`/api/me/usage` 和 `/api/admin/usage`；Agent 的主人另有 `/api/agents/:id/usage`。

## 9. 安全

| 风险 | 规则 |
| --- | --- |
| Key 外泄 | 机密加密存储，任何接口都不返回明文；Key 只发往它所在实例的 base URL；改 base URL 必须重填 Key；预设没有地址时报错，不会回退到别的实例或环境变量的地址 |
| SSRF | 成员的个人实例只能用公网 https 地址或预设地址：保存时检查解析结果，每次连接时再检查一次（防 DNS 重绑定）；内网、回环、链路本地地址一律拒绝。工作区实例由管理员配置，可以用内网地址（例如本地 Ollama） |
| 越权 | 个人实例只服务它的主人，不能用于公开 Agent 或别人发起的运行；工作区实例遵守成员的模块权限与预算 |
| 审计 | 新增、修改、删除、启停实例都写审计记录（谁、何时、哪个字段，不含机密） |
| 入站邮件 | `/api/mail/inbound/:instance` 先验签再做任何事；通知只是信号，信用实例的 Key 从服务商拉取；nonce 一次性；来信按发件人名单与对齐的 SPF / DKIM / DMARC 决定是否叫醒 Agent（见 PRD §8.4） |
| 内容 | 发给 STT、TTS、图像、视频服务商的内容属于成员本人或其授权范围；界面「?」里写明「内容会发送给所选服务商」 |

## 10. 扩展

`greenhouse.config.ts` 的扩展可以注册适配器：

```ts
export default defineExtension({ id: 'acme', providers: [acmeSttAdapter] });
```

扩展适配器和核心适配器走同一个注册表、同一个界面和同一套安全规则；扩展停用后，它的实例自动停用。

## 11. 从 v1 迁移（M5，按需）

v2 从零建表，部署时直接按本文配置。下表给需要从 v1 搬配置的部署参考；迁移工具见 [migration-v1.md](migration-v1.md)。

| v1 | v2 |
| --- | --- |
| `LLM_*`、`DEEPSEEK_API_KEY`、`models.yaml` | `LLM_*` 简单形式，或 `providers.yaml`；`LLM_MODEL_PRO` 改名为 `LLM_MODEL_STRONG` |
| `MEDIA_*`、`IMAGE_*`、`VISION_MODEL` | 图像实例；读图交给 LLM 的 `vision` 模型，或在默认项里指定一个读图模型 |
| `TAVILY_API_KEY`、`FIRECRAWL_API_KEY`、`BRAVE_SEARCH_API_KEY` | 搜索实例，`SEARCH_PROVIDER` 决定顺序 |
| `BOTS_COMPUTER_*`、`MISSION_*`、`SANDBOX_RUNNER_*`、`CLOUD_AGENT_*` | 沙箱实例；Mission 相关变量删除 |
| `TENCENT_CLOUD_COS_*`、`SKILLS_S3_*`、`BOTS_COMPUTER_BACKUP_S3_*` | 合并为一个存储实例，按用途用前缀区分 |
| `workspace_settings` 里的 `llm.*`、`media.*`、`search.*`、`bots.computer_*` | 由迁移工具写成 `providers` 与 `provider_bindings` |
| Runtime Config 页、AI Gateway 页、Agent computers 页 | 「管理 → 服务」 |

## 12. 代码布局

```
packages/providers/          纯适配层：接口、注册表、通用适配器（llm / stt / tts / image / video / search / storage）、预设
                             只依赖 zod、AI SDK、fetch；不访问数据库，不定义 HTTP 路由
apps/api/src/providers/      解析与管理：环境变量引导、数据库读写与加密、策略、回退、计量、版本广播
                             路由 /api/admin/providers*、/api/me/providers*
packages/providers/src/sandbox/   沙箱适配器：docker（Docker CLI）、e2b（纯 HTTP 与 WebSocket，不用 E2B SDK）
packages/providers/src/mail/      邮箱适配器：resend、mailgun（收发，纯 HTTP）；smtp 在 apps/api/src/modules/mail/smtp.ts
apps/api/src/providers/e2b-template.ts   用 E2B SDK 构建电脑模板，只给 scripts/e2b-template.mts 和实测用
```

验收要求：
- 业务代码里 `grep process.env` 只能出现在 `apps/api/src/config/`。
- 每个适配器都有一份测试（模拟 HTTP），覆盖「Key 只发往配置的地址」。
- 「测试连接」在界面上可以用。
