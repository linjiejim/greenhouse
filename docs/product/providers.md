# 服务 Provider 体系

更新 2026-10-13 · 状态：设计已定，待实现（[功能清单](features.md) PRV-01…15）· 配套 [PRD §8.1](prd.md#81-服务provider)

## 1. 目标

- 能力和厂商解耦。 8 类外部能力都可以换厂商；业务代码只依赖能力接口，不出现厂商名。
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

渠道也是 Provider，和上面 8 类用同一张表、同一套解析与安全规则，在「管理 → 服务 → 渠道」里配置：

| 能力 | ID | 消费方 | 未配置时 |
| --- | --- | --- | --- |
| 邮件发送 | `mail` | 通知送达（SMTP）；以后也发邀请和重置密码 | 邀请改为复制链接；邮件渠道不出现 |
| 即时通讯 | `im` | 飞书、企微：通知送达；以后也做扫码登录、机器人 | 对应登录与渠道不出现 |
| 推送 | `push` | 手机推送（Expo 推送服务，它替官方 App 持有 APNs / FCM 凭据） | 不推送，只有站内通知 |

渠道和 8 类能力有三处不同：
- 一个渠道由同类实例（`smtp`、`feishu`、`wecom`、`expo`）在工作区顺序里的第一个提供，不回退到第二个：渠道关了就是关了。飞书和企微同属 `im`，按类型各取各的。
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
SANDBOX_PROVIDER=docker          # docker（已实现）| e2b（待移植）
SANDBOX_IMAGE=greenhouse/computer:latest  SANDBOX_DOCKER_RUNTIME=runsc   # runsc = gVisor，生产必须；runc 只用于开发
SANDBOX_NETWORK=bridge  SANDBOX_MEMORY=2g  SANDBOX_CPUS=2
SEARCH_PROVIDER=tavily,brave     # 多个用逗号分隔，就是回退顺序
TAVILY_API_KEY=…  BRAVE_API_KEY=…
STORAGE_PROVIDER=s3              # local | s3
STORAGE_ENDPOINT=https://cos.ap-shanghai.myqcloud.com  STORAGE_BUCKET=…  STORAGE_REGION=ap-shanghai
STORAGE_ACCESS_KEY_ID=…  STORAGE_SECRET_ACCESS_KEY=…  STORAGE_PREFIX=greenhouse/  STORAGE_FORCE_PATH_STYLE=false

# 渠道（通知送达）；设置不全的渠道启动时告警并忽略
SMTP_HOST=smtp.example.com       SMTP_SECURITY=starttls   # tls | starttls（默认）| none；SMTP_PORT 默认 465 / 587 / 25
SMTP_USER=…  SMTP_PASSWORD=…  SMTP_FROM=greenhouse@example.com  SMTP_FROM_NAME=Greenhouse
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
interface SandboxClient { create(s: SandboxSpec): Promise<SandboxHandle>; get(id: string): Promise<SandboxHandle | null> }   // 由 v1 的 ComputerHost 泛化
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
| `e2b` | E2B；E2B 协议兼容服务（PPIO 等，填写 domain） | Daytona、Modal、Kubernetes |

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

### 渠道 `mail` / `im` / `push`

| 能力 | 适配器 | v2.0 | 后续 |
| --- | --- | --- | --- |
| `mail` | `smtp` | 任意 SMTP 服务器（tls / starttls / none）；用 nodemailer，所以写在 API 里（`apps/api/src/modules/channels/smtp.ts`），像扩展一样注册；地址是 `smtp://主机:端口`，换地址清空密码 | 邮件服务商的 HTTP API |
| `im` | `feishu`、`wecom` | 飞书（含 Lark 预设）与企微自建应用，纯文本私信；令牌按应用缓存 | 飞书消息卡片 |
| `push` | `expo` | Expo 推送服务：按项目分组、每次最多 100 条，15 分钟后查回执 | 直连 APNs / FCM |

## 7. 界面

管理 → 服务

- 8 行能力加 1 行渠道，每行显示：能力名、浅色「?」（能力用在哪里）、当前实例与来源标签、状态点、「配置」。
- 点「配置」在右侧抽屉里管理这个能力：
  - 实例列表：可以拖动排序，顺序就是回退顺序。
  - 添加实例：先选厂商预设；表单由 `configSchema` 生成，Key 只写不读。
  - 测试连接：显示耗时和返回的错误原文。
  - 默认项：模型、音色、尺寸。
  - 策略：一个开关「允许成员使用自己的 Key」。
- 沙箱的抽屉里额外有：电脑容量（空闲分钟数、最大并发）、电脑列表（停止、重置、备份）。
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
apps/api/src/sandbox/        沙箱适配器（docker、e2b）：依赖 Docker CLI 与 E2B SDK，所以放在 API 里，实现 packages/providers 的接口
```

验收要求：
- 业务代码里 `grep process.env` 只能出现在 `apps/api/src/config/`。
- 每个适配器都有一份测试（模拟 HTTP），覆盖「Key 只发往配置的地址」。
- 「测试连接」在界面上可以用。
