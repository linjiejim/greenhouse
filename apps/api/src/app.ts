import { createAutomationsService, type AutomationsService } from './modules/tables/automations.js';
import { createRecordAgents, type RecordAgentsService } from './modules/tables/agents.js';
import { automationsRoutes } from './modules/tables/automations-routes.js';
import { appTools } from './engine/tools/apps.js';
import { appsRoutes } from './modules/apps/routes.js';
import { createAppsService, type AppsService } from './modules/apps/service.js';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { API_VERSION } from '@greenhouse/contract';
import type { AppConfig } from './config/index.js';
import { requireAdmin, requireMember } from './auth/middleware.js';
import { createTokens, type Tokens } from './auth/tokens.js';
import { handleError, handleNotFound } from './http/errors.js';
import type { AppEnv } from './http/env.js';
import { webRoutes } from './http/web.js';
import { cors, securityHeaders } from './security/headers.js';
import { RateLimiter } from './security/rate-limit.js';
import { requestSourceIp } from './security/request-ip.js';
import { authRoutes } from './modules/auth/routes.js';
import { createAuthService, type AuthService } from './modules/auth/service.js';
import { adminMemberRoutes, directoryRoutes, groupDirectoryRoutes, meRoutes } from './modules/members/routes.js';
import { createMembersService, type MembersService } from './modules/members/service.js';
import { bootstrapRoutes, brandingRoutes } from './modules/workspace/routes.js';
import { createWorkspaceService, type WorkspaceService } from './modules/workspace/service.js';
import { createEngine, type Engine } from './engine/engine.js';
import { askUserTool } from './engine/tools/ask-user.js';
import { helperRunTool } from './engine/tools/helper-run.js';
import { toolOutputReadTool } from './engine/tools/output.js';
import { readAttachmentTool } from './engine/tools/attachments.js';
import { computerTool } from './engine/tools/computer.js';
import { conversationTool } from './engine/tools/conversation.js';
import { handoffTool } from './engine/tools/handoff.js';
import { memoryTool } from './engine/tools/memory.js';
import type { ToolDef } from './engine/tools/define.js';
import { runStartTool } from './engine/tools/run-start.js';
import { runFinishTool } from './engine/tools/run-finish.js';
import { scheduleTools } from './engine/tools/schedules.js';
import { selfTool } from './engine/tools/self.js';
import { skillMutationTool } from './engine/tools/skill-mutation.js';
import { skillQueryTool } from './engine/tools/skill-query.js';
import { requestTakeoverTool } from './engine/tools/takeover.js';
import { browserTool } from './engine/tools/browser.js';
import { vaultTool } from './engine/tools/vault.js';
import { mailTool } from './engine/tools/mail.js';
import { webTools } from './engine/tools/web.js';
import { knowledgeTools } from './engine/tools/knowledge.js';
import { tableTools } from './engine/tools/tables.js';
import { adminPublicAgentRoutes, agentRoutes } from './modules/agents/routes.js';
import { createAgentsService, type AgentsService } from './modules/agents/service.js';
import { createApprovalsService, type ApprovalsService } from './modules/agents/approvals.js';
import { adminComputerRoutes, computerRoutes } from './modules/computers/routes.js';
import { connectorTool } from './engine/tools/connectors.js';
import { adminConnectorRoutes, connectorCallbackRoutes, myConnectionRoutes } from './modules/connectors/routes.js';
import { createConnectorsService, type ConnectorsService } from './modules/connectors/service.js';
import { createComputersService, type ComputersService } from './modules/computers/service.js';
import { createBrowserService, ownOrigins, type BrowserService } from './modules/computers/browser.js';
import { vaultRoutes } from './modules/vault/routes.js';
import { createVaultService, type VaultService } from './modules/vault/service.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { fileContentRoutes, fileRoutes } from './modules/files/routes.js';
import { voiceRoutes } from './modules/voice/routes.js';
import { createVoiceService, type VoiceService } from './modules/voice/service.js';
import { createFilesService, type FilesService } from './modules/files/service.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { createKnowledgeService, type KnowledgeService } from './modules/knowledge/service.js';
import { cardsRoutes } from './modules/tables/cards-routes.js';
import { formsRoutes } from './modules/tables/forms-routes.js';
import { importsRoutes } from './modules/tables/imports-routes.js';
import { tablesRoutes } from './modules/tables/routes.js';
import { createTablesService, type TablesService } from './modules/tables/service.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { createNotificationsService, type NotificationsService } from './modules/notifications/service.js';
import { adminChannelRoutes, notificationSettingsRoutes, pushDeviceRoutes } from './modules/channels/routes.js';
import { createChannelsService, type ChannelsService } from './modules/channels/service.js';
import { adminMailRoutes, agentMailRoutes, mailInboundRoutes } from './modules/mail/routes.js';
import { createMailService, type MailService } from './modules/mail/service.js';
import { requestRoutes } from './modules/requests/routes.js';
import { runRoutes } from './modules/runs/routes.js';
import { scheduleRoutes } from './modules/schedules/routes.js';
import { createSchedulesService, type SchedulesService } from './modules/schedules/service.js';
import { createRunsService, type RunsService } from './modules/runs/service.js';
import { createRequestsService, type RequestsService } from './modules/requests/service.js';
import { createConversationsService, type ConversationsService } from './modules/conversations/service.js';
import { searchRoutes } from './modules/search/routes.js';
import { skillRoutes } from './modules/skills/routes.js';
import { createSkillsService, type SkillsService } from './modules/skills/service.js';
import { createSearchService, type SearchService } from './modules/search/service.js';
import { adminUsageRoutes, agentUsageRoutes, myUsageRoutes } from './modules/usage/routes.js';
import { createUsageService, type UsageService } from './modules/usage/service.js';
import { mcpRoutes } from './modules/mcp/routes.js';
import {
  adminClientRoutes,
  grantRoutes,
  oauthConsentRoutes,
  oauthProtocolRoutes,
  personalTokenRoutes,
} from './modules/oauth/routes.js';
import { createOAuthService, type OAuthService } from './modules/oauth/service.js';
import { createHub, type Hub } from './realtime/hub.js';
import { adminProviderRoutes, myModelRoutes, myProviderRoutes } from './providers/routes.js';
import { createProvidersService, type ProvidersService } from './providers/service.js';

export interface Services {
  config: AppConfig;
  tokens: Tokens;
  auth: AuthService;
  workspace: WorkspaceService;
  members: MembersService;
  providers: ProvidersService;
  agents: AgentsService;
  approvals: ApprovalsService;
  computers: ComputersService;
  connectors: ConnectorsService;
  browser: BrowserService;
  vault: VaultService;
  conversations: ConversationsService;
  files: FilesService;
  voice: VoiceService;
  knowledge: KnowledgeService;
  tables: TablesService;
  automations: AutomationsService;
  recordAgents: RecordAgentsService;
  apps: AppsService;
  notifications: NotificationsService;
  channels: ChannelsService;
  mail: MailService;
  requests: RequestsService;
  runs: RunsService;
  schedules: SchedulesService;
  search: SearchService;
  skills: SkillsService;
  usage: UsageService;
  hub: Hub;
  engine: Engine;
  limiter: RateLimiter;
  oauth: OAuthService;
}

export interface ServiceOptions {
  /** Replaces the network for provider calls (tests). */
  fetch?: typeof fetch;
  /** Replaces model resolution in the engine (tests). */
  languageModel?: ProvidersService['languageModel'];
  /** Tools added to the built-in ones (extensions, tests). */
  tools?: readonly ToolDef[];
  /** Replaces the connector catalog and the MCP Registry address (tests). */
  connectors?: Omit<Parameters<typeof createConnectorsService>[0], 'config'>;
}

export function createServices(config: AppConfig, options: ServiceOptions = {}): Services {
  const tokens = createTokens(config.tokenSigningKey);
  const auth = createAuthService({ tokens, publicUrl: config.PUBLIC_URL });
  const providers = createProvidersService({ config, fetch: options.fetch });
  const files = createFilesService({ providers, sign: (data) => tokens.hashSecret(data, 'file') });
  const voice = createVoiceService({ providers, files });
  // Equipping a skill checks it can run for the Agent (the skills service is made below).
  const agents = createAgentsService({
    providers,
    files,
    equip: (memberId, manifest, added) => skills.assertEquippable(memberId, manifest, added),
  });
  const hub = createHub();
  const channels = createChannelsService({ config, providers });
  const notifications = createNotificationsService({ hub, deliveries: channels });
  const conversations = createConversationsService({ agents, providers, hub, files, notifications });
  // Mail wakes Agents through the engine, which is made below.
  const mail = createMailService({ config, providers, files, agents, conversations, engine: () => engine });
  const members = createMembersService({ auth, providers, files, mail });
  // A socket ticket is a one-time link: random, stored only as a keyed hash.
  const computers = createComputersService({
    providers,
    agents,
    hub,
    secrets: { create: () => tokens.newSecret(), hash: (secret) => tokens.hashSecret(secret, 'link') },
  });
  const connectors = createConnectorsService({ config, ...options.connectors });
  // The browser and the vault never reach Greenhouse itself; what a page shows is redacted against the vault.
  const forbiddenOrigins = ownOrigins(config);
  const vault = createVaultService({ config, hub, forbiddenOrigins });
  const browser = createBrowserService({
    computers,
    secrets: (memberId) => vault.secretsOf(memberId),
    forbiddenOrigins,
  });
  const skills = createSkillsService({ files, providers, agents, connectors, computers, notifications });
  const knowledge = createKnowledgeService({
    files,
    notifications,
    hub,
    publicUrl: config.PUBLIC_URL,
    engine: () => engine,
  });
  const tables = createTablesService({ files, notifications, hub, providers });
  const apps = createAppsService({ tables, notifications });
  // Who sees a base is cached a few seconds; a change of groups, modules or status forgets it at once.
  members.onAccessChange(() => tables.forgetAudiences());
  const schedules = createSchedulesService({ agents, background: () => engine.background });
  // A committed decision wakes the engine's worker (made below) rather than waiting for its poll.
  const approvals = createApprovalsService(agents, knowledge, tables);
  const requests = createRequestsService({ hub, notifications, approvals, decided: () => engine.wakeDecisions() });
  const engine = createEngine({
    eventWakeLimit: config.AGENT_EVENT_WAKES_PER_DAY,
    eventMergeMs: config.AGENT_EVENT_MERGE_MS,
    approvals,
    computers,
    agents,
    conversations,
    providers,
    requests,
    files,
    notifications,
    hub,
    skills,
    tools: ({ background, handOff }) => [
      memoryTool(agents),
      askUserTool(),
      selfTool(agents),
      conversationTool(conversations),
      readAttachmentTool(files, voice),
      toolOutputReadTool(files),
      computerTool(computers),
      requestTakeoverTool(),
      browserTool(browser),
      vaultTool(vault, browser),
      runStartTool(background),
      helperRunTool(background),
      runFinishTool(computers),
      handoffTool(handOff),
      ...scheduleTools(schedules),
      ...webTools(providers, options.fetch ? { fetch: options.fetch } : {}),
      connectorTool(connectors),
      mailTool(mail),
      skillQueryTool(skills),
      skillMutationTool(skills),
      ...knowledgeTools(knowledge),
      ...tableTools(tables),
      ...appTools(apps, tables),
      ...(options.tools ?? []),
    ],
    ...(options.languageModel ? { languageModel: options.languageModel } : {}),
    development: config.NODE_ENV === 'development',
  });
  const recordAgents = createRecordAgents({ tables, agents, engine: () => engine });
  const automations = createAutomationsService({
    tables,
    agents,
    engine: () => engine,
    notifications,
    key: Buffer.from(config.providerEncryptionKey, 'hex'),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  tables.installAutomationHooks(automations.hooks);
  tables.worker.register('base_automation', automations.handle);
  tables.worker.every(automations.sweep);
  const runs = createRunsService({ background: () => engine.background });
  return {
    config,
    tokens,
    auth,
    workspace: createWorkspaceService({ files }),
    members,
    providers,
    agents,
    computers,
    approvals,
    connectors,
    browser,
    vault,
    conversations,
    files,
    voice,
    knowledge,
    tables,
    automations,
    recordAgents,
    apps,
    notifications,
    channels,
    mail,
    requests,
    runs,
    schedules,
    search: createSearchService({ members, knowledge, tables, apps }),
    skills,
    usage: createUsageService({ agents, providers }),
    hub,
    engine,
    limiter: new RateLimiter(10, 60_000),
    oauth: createOAuthService({ tokens, publicUrl: config.PUBLIC_URL }),
  };
}

/**
 * The HTTP surface. Public: /health, /api/bootstrap, /api/auth/*, file content behind a signed URL
 * (GET /api/files/:id/content?exp=&m=&sig=), the connector sign-in callback
 * (GET /api/connectors/oauth/callback, which changes nothing), a mail vendor's signed notice of received mail
 * (POST /api/mail/inbound/:instance, refused unless its signature verifies), the OAuth endpoints (/.well-known/*,
 * /oauth/*), the MCP server /api/mcp (its own OAuth or personal bearer tokens), and the built web
 * app at /.
 * Everything else under /api requires a member; /api/admin/* also requires an admin.
 */
export function createApp(services: Services, options: { webDir?: string } = {}) {
  const { config } = services;
  const member = requireMember(services.tokens);
  const trust = { trustedProxies: config.trustedProxyIps, proxyHops: config.TRUSTED_PROXY_HOPS };

  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.use('*', securityHeaders, cors(config.corsAllowedOrigins), async (c, next) => {
    c.set('requestId', c.req.header('x-request-id')?.slice(0, 64) || randomUUID());
    await next();
  });

  app.get('/health', async (c) => {
    try {
      return c.json({ ok: true, api_version: API_VERSION, services: await services.providers.status() });
    } catch {
      return c.json({ ok: false, api_version: API_VERSION }, 503);
    }
  });
  app.route('/api/bootstrap', bootstrapRoutes(services.workspace));
  app.route(
    '/api/auth',
    authRoutes({ auth: services.auth, limiter: services.limiter, clientIp: (c) => requestSourceIp(c as never, trust) }),
  );
  // An <img> or a link cannot send a bearer header: the URL's signature is the credential.
  app.route('/api/files', fileContentRoutes(services.files));
  // A provider sends the member's browser back here without a bearer header; the web app finishes it.
  app.route('/api/connectors', connectorCallbackRoutes(services.connectors));
  // A mail vendor's notice: its own signature is the credential, and the mail is fetched from the vendor.
  app.route('/api/mail', mailInboundRoutes(services.mail));
  // External access: OAuth 2.1 metadata and endpoints, and the MCP server with its own bearer tokens.
  app.route('/', oauthProtocolRoutes({ oauth: services.oauth, clientIp: (c) => requestSourceIp(c as never, trust) }));
  app.route('/api/mcp', mcpRoutes({ oauth: services.oauth, services }));

  const signedIn = new Hono<AppEnv>();
  signedIn.use('*', member);
  signedIn.route('/me/providers', myProviderRoutes(services.providers));
  signedIn.route('/me/models', myModelRoutes(services.providers));
  signedIn.route('/me/usage', myUsageRoutes(services.usage));
  signedIn.route('/me/connections', myConnectionRoutes(services.connectors));
  signedIn.route('/me/tokens', personalTokenRoutes(services.oauth));
  signedIn.route('/me/grants', grantRoutes(services.oauth));
  signedIn.route('/me/notification-settings', notificationSettingsRoutes(services.channels));
  signedIn.route('/me/push-devices', pushDeviceRoutes(services.channels));
  signedIn.route('/oauth', oauthConsentRoutes(services.oauth));
  signedIn.route('/me/vault', vaultRoutes(services.vault));
  signedIn.route('/me', meRoutes(services.members));
  signedIn.route('/members', directoryRoutes(services.members));
  signedIn.route('/groups', groupDirectoryRoutes(services.members));
  signedIn.route('/agents', agentRoutes(services.agents, services.approvals));
  signedIn.route('/agents', agentUsageRoutes(services.usage));
  signedIn.route('/agents', computerRoutes(services.computers));
  signedIn.route('/agents', agentMailRoutes(services.mail));
  signedIn.route('/conversations', conversationRoutes(services.conversations, services.engine));
  signedIn.route('/requests', requestRoutes(services.requests));
  signedIn.route('/runs', runRoutes(services.runs, services.engine));
  signedIn.route('/files', fileRoutes(services.files, services.conversations));
  signedIn.route('/voice', voiceRoutes(services.voice));
  signedIn.route('/schedules', scheduleRoutes(services.schedules));
  signedIn.route('/notifications', notificationRoutes(services.notifications));
  signedIn.route('/search', searchRoutes(services.search));
  signedIn.route('/skills', skillRoutes(services.skills));
  signedIn.route('/knowledge', knowledgeRoutes(services.knowledge));
  signedIn.route('/apps', appsRoutes(services.apps));
  signedIn.route('/tables', tablesRoutes(services.tables));
  signedIn.route('/tables', automationsRoutes(services.automations, services.recordAgents));
  signedIn.route('/tables', formsRoutes(services.tables.forms));
  signedIn.route('/tables', importsRoutes(services.tables.imports));
  signedIn.route('/tables', cardsRoutes(services.tables.cards));
  signedIn.use('/admin/*', requireAdmin);
  signedIn.route('/admin', adminMemberRoutes(services.members));
  signedIn.route('/admin/branding', brandingRoutes(services.workspace));
  signedIn.route('/admin', adminProviderRoutes(services.providers));
  signedIn.route('/admin', adminUsageRoutes(services.usage));
  signedIn.route('/admin', adminPublicAgentRoutes(services.agents));
  signedIn.route('/admin/computers', adminComputerRoutes(services.computers));
  signedIn.route('/admin/connectors', adminConnectorRoutes(services.connectors));
  signedIn.route('/admin/clients', adminClientRoutes(services.oauth));
  signedIn.route('/admin/channels', adminChannelRoutes(services.channels));
  signedIn.route('/admin/mail', adminMailRoutes(services.mail));
  app.route('/api', signedIn);
  app.route('/', webRoutes(options.webDir));

  return app;
}

export type App = ReturnType<typeof createApp>;
