#!/usr/bin/env node
/**
 * run-dev 引擎 —— 一键拉起本地验收环境（方案见 docs/specs/20260730-run-dev-and-local-sandbox.md）
 *
 * 用法（供 /run-dev 技能驱动，也可手动跑）：
 *   node scripts/run-dev.mjs up [all|web|api] [--fresh] [--sandbox] [--mission] [--db <name>]
 *   node scripts/run-dev.mjs stop [--wipe]
 *   node scripts/run-dev.mjs status
 *
 * 职责边界：确定性编排全在本脚本（端口分配 / env 联动 / 进程组管理 / 日志捕获 /
 * state.json / 健康轮询 / 沙箱库 / 账号确保 / worktree 自举）；意图解析与浏览器挂载
 * 在技能层（.claude/skills/run-dev）。单文件引擎，按本仓库的
 * 「一个 Postgres + api + web」形态收敛（差异逐条记在 spec 的决策记录里）。
 *
 * 端口冲突纪律（裸 lsof 曾误杀 OrbStack，规则保守）：
 *   - 只用 lsof -sTCP:LISTEN 找「监听者」，绝不裸 lsof；
 *   - 仅当监听进程 cwd == 本树根（本树残留）才杀其进程组，其余一律 +10 梯度避让。
 *
 * 数据面纪律：worktree 默认走**同一个本地 Postgres 里的独立库**（greenhouse_wt_<slug>），
 * 绝不动主库；`stop` 不关 Postgres（它被主树/其它 worktree/其它项目共用），
 * `stop --wipe` 只 DROP 沙箱库，且硬性拒绝 greenhouse_wt_ 前缀之外的库名。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 常量与路径
// ============================================================================
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.run-dev');
const LOG_DIR = path.join(RUN_DIR, 'logs');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml');
const DEFAULT_DB_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';

/** 沙箱库前缀 —— `--wipe` 的 DROP 白名单就是它，别改成会命中主库的前缀。 */
const SANDBOX_DB_PREFIX = 'greenhouse_wt_';
const MISSION_NETWORK_LABEL = 'greenhouse.run-dev.root';

// 本地种子账号：仅当目标库里**一个 super 都没有**时才建（真实账密不入库，
// 见 AGENTS.md「测试」；已有账号的库只提醒、不改密）。可用 env 覆盖。
const SEED_EMAIL = process.env.RUN_DEV_EMAIL || 'admin@example.com';
const SEED_PASSWORD = process.env.RUN_DEV_PASSWORD || 'greenhouse';
const SEED_NICKNAME = process.env.RUN_DEV_NICKNAME || 'Test';

// 服务定义：基准端口 + 健康路径 + 健康超时（秒）。基准与 `pnpm dev` 一致，
// 主树占用时按 +10 梯度避让（3110/3111、3120/3121…，与既有 worktree 习惯同型）。
const SERVICES = {
  api: { base: 3101, health: '/health', timeout: 120 },
  web: { base: 3100, health: '/', timeout: 120 },
};

// target → 服务组合。web 目标自带 api（Vite 只是代理，没有 api 就是空壳）。
const TARGETS = {
  all: ['api', 'web'],
  web: ['api', 'web'],
  api: ['api'],
};

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' };
const info = (m) => console.log(`${C.g}[run-dev]${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}[run-dev]${C.x} ${m}`);
const fail = (m) => console.error(`${C.r}[run-dev]${C.x} ${m}`);

// ============================================================================
// 小工具
// ============================================================================
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** 本树是否 worktree（.git 是文件而非目录） */
function isWorktree() {
  try {
    return fs.statSync(path.join(ROOT, '.git')).isFile();
  } catch {
    return false;
  }
}

/** 主树根（worktree 下解析 git-common-dir；主树下即 ROOT） */
function mainTreeRoot() {
  if (!isWorktree()) return ROOT;
  const r = sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT });
  return r.code === 0 ? path.dirname(r.out) : ROOT;
}

function worktreeSlug() {
  return (
    path
      .basename(ROOT)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'wt'
  );
}

/** 极简 .env 读取（只为拿 DATABASE_URL，不引 dotenv：引擎必须零依赖可跑） */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ============================================================================
// 可选 Mission 本地执行面（显式 --mission；不改变默认启动语义）
// ============================================================================
function missionNetworkName() {
  return `greenhouse-mission-${worktreeSlug().replaceAll('_', '-')}`.slice(0, 63);
}

function inspectDockerNetwork(name) {
  const r = sh('docker', ['network', 'inspect', name, '--format', '{{json .}}']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`Docker network ${name} 返回了不可读的 inspect 数据`);
  }
}

/**
 * Local Mission deliberately uses a per-tree bridge rather than mutating the
 * deployment network (`cloud-agent`). The label is the ownership proof used by
 * stop; an existing same-name network without it is refused, never adopted.
 */
function ensureMissionInfra(state, image) {
  if (sh('docker', ['info']).code !== 0) throw new Error('Mission --mission 需要可用的本地 Docker daemon');
  if (sh('docker', ['image', 'inspect', image]).code !== 0) {
    throw new Error(`缺少 Mission 镜像 ${image}；先运行 bash scripts/build-agent-runtime.sh`);
  }

  const network = missionNetworkName();
  let inspected = inspectDockerNetwork(network);
  if (!inspected) {
    info(`创建本树 Mission 网络 ${network}（ICC=false, IPv6=false）…`);
    const created = sh('docker', [
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      '--label',
      `${MISSION_NETWORK_LABEL}=${ROOT}`,
      network,
    ]);
    if (created.code !== 0) throw new Error(`创建 Mission 网络失败：${created.err}`);
    inspected = inspectDockerNetwork(network);
  }

  if (inspected?.Labels?.[MISSION_NETWORK_LABEL] !== ROOT) {
    throw new Error(`Mission 网络 ${network} 不属于本树，拒绝复用；请人工确认后处理同名网络`);
  }
  if (inspected.EnableIPv6 !== false || inspected.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
    throw new Error(`Mission 网络 ${network} 不安全（要求 IPv6=false 且 enable_icc=false）`);
  }

  state.mission = {
    requested: true,
    image,
    network,
    dataRoot: path.join(RUN_DIR, 'mission-data'),
  };
  writeState(state);
}

async function readHealth(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`health 返回 ${res.status}`);
  return res.json();
}

async function assertMissionReady(state, port) {
  const deadline = Date.now() + 30_000;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const health = await readHealth(port);
    lastState = health?.mission?.state ?? 'unknown';
    if (lastState === 'ready') {
      state.mission.health = health.mission;
      writeState(state);
      info('Mission admission ready ✓（本地 runc + monitor-only quota）');
      return;
    }
    // Mission initializes asynchronously after the HTTP listener starts. Its
    // initial public state is `disabled`, so one immediate read is a race, not
    // a verdict. `unavailable` is also polled to the same deadline: containment
    // may still be settling and the final log carries the actionable reason.
    await sleep(500);
  }
  throw new Error(`Mission 30 秒内未就绪（state=${lastState}），查 .run-dev/logs/api.log`);
}

function stopMissionInfra(state) {
  const mission = state?.mission;
  if (!mission?.network) return;

  const listed = sh('docker', [
    'ps',
    '-aq',
    '--filter',
    `network=${mission.network}`,
    '--filter',
    'label=greenhouse.cloud-agent.run',
  ]);
  for (const id of listed.out.split('\n').filter(Boolean)) {
    const removed = sh('docker', ['rm', '-f', id]);
    if (removed.code === 0) info(`停 Mission sandbox ${id.slice(0, 12)}`);
    else warn(`Mission sandbox ${id.slice(0, 12)} 回收失败：${removed.err.split('\n')[0]}`);
  }

  const inspected = inspectDockerNetwork(mission.network);
  if (!inspected) return;
  if (inspected.Labels?.[MISSION_NETWORK_LABEL] !== ROOT) {
    warn(`Mission 网络 ${mission.network} 所有权标签不匹配，保留`);
    return;
  }
  const removed = sh('docker', ['network', 'rm', mission.network]);
  if (removed.code === 0) info(`已删本树 Mission 网络 ${mission.network}`);
  else warn(`Mission 网络 ${mission.network} 未删：${removed.err.split('\n')[0]}`);
}

// ============================================================================
// 端口：监听者识别 + 分配
// ============================================================================
/** 返回端口监听者 {pid, command, cwd} 或 null。只认 LISTEN，绝不裸 lsof。 */
function listenerOnPort(port) {
  const r = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const pid = r.out
    .split('\n')
    .find((l) => l.startsWith('p'))
    ?.slice(1);
  if (!pid) return null;
  const command = sh('ps', ['-p', pid, '-o', 'command=']).out;
  const cwd = sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
    .out.split('\n')
    .find((l) => l.startsWith('n'))
    ?.slice(1);
  return { pid: Number(pid), command, cwd };
}

const DEV_PROC_RE = /node|vite|tsx|pnpm|esbuild/i;

function killProcessGroup(pid, label) {
  const pgid = Number(sh('ps', ['-p', String(pid), '-o', 'pgid=']).out);
  if (!pgid) return;
  info(`回收 ${label}（pid=${pid} pgid=${pgid}）`);
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    /* 已退出 */
  }
}

async function waitPortFree(port, seconds = 8) {
  for (let i = 0; i < seconds * 2; i++) {
    if (!listenerOnPort(port)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * 为服务分配端口：基准空闲直接用；被**本树**残留占用则杀组回收；
 * 其它占用者（主树 pnpm dev / 别的 worktree / 未知进程）不动，+10 梯度避让。
 */
async function allocatePort(name) {
  const base = SERVICES[name].base;
  for (let off = 0; off <= 100; off += 10) {
    const port = base + off;
    const holder = listenerOnPort(port);
    if (!holder) return port;
    if (holder.cwd === ROOT && DEV_PROC_RE.test(holder.command)) {
      killProcessGroup(holder.pid, `${name}:${port} 本树残留`);
      if (await waitPortFree(port)) return port;
      try {
        process.kill(-Number(sh('ps', ['-p', String(holder.pid), '-o', 'pgid=']).out), 'SIGKILL');
      } catch {
        /* 已退出 */
      }
      if (await waitPortFree(port, 3)) return port;
    }
    warn(`端口 ${port} 被占（${(holder.command || '?').slice(0, 60)}｜cwd=${holder.cwd}），避让`);
  }
  throw new Error(`${name}: 基准 ${base} 起 +100 内无可用端口`);
}

// ============================================================================
// 进程启动 + 日志捕获
// ============================================================================
function openLog(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${name}.log`);
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`); // 上一轮转存，只留一代
  return { file, fd: fs.openSync(file, 'a') };
}

function launch(state, name, cmd, args, env, port) {
  const { file, fd } = openLog(name);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true, // 独立进程组，stop 时整组回收
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  state.services[name] = {
    pid: child.pid,
    pgid: child.pid, // detached → 自成组长
    port,
    cmd: [cmd, ...args].join(' '),
    // stop 时的防误杀指纹：args 串会出现在 ps 命令行里（pnpm 经 node shim 跑，
    // 首列可执行名不可靠），pid 复用时靠它识别出「这不是我们启的那个进程」。
    marker: args.join(' '),
    log: path.relative(ROOT, file),
    startedAt: new Date().toISOString(),
  };
  writeState(state); // 每启一个就落盘，崩了也能 stop 清理
  info(`启动 ${name}${port ? ` :${port}` : ''} → ${path.relative(ROOT, file)}`);
}

async function waitHealthy(name, port) {
  const svc = SERVICES[name];
  // 两个 host 都探：api 监听 IPv4，Vite 8 只监听 `localhost` 解析出的 **IPv6 [::1]**，
  // 单探 127.0.0.1 会把已就绪的 web 判成超时。
  const urls = [`http://127.0.0.1:${port}${svc.health}`, `http://localhost:${port}${svc.health}`];
  const deadline = Date.now() + svc.timeout * 1000;
  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        // api 的 /health 在库连不上时返回 503——那不是「还没起来」而是真故障，
        // 一样继续轮询到超时后由调用方报错并指向日志。
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return true;
      } catch {
        /* 未就绪，继续轮询 */
      }
    }
    await sleep(1500);
  }
  return false;
}

// ============================================================================
// 数据面：一个本地 Postgres（容器共用）+ 每 worktree 一个独立库
// ============================================================================
/** 解析 DATABASE_URL → {host, port, user, password, db}（失败即抛，别静默回落） */
function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'greenhouse'),
    password: decodeURIComponent(u.password || ''),
    db: u.pathname.replace(/^\//, '') || 'greenhouse',
  };
}

function buildDbUrl(cfg, db = cfg.db) {
  const auth = cfg.password ? `${cfg.user}:${encodeURIComponent(cfg.password)}` : cfg.user;
  return `postgresql://${auth}@${cfg.host}:${cfg.port}/${db}`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 找发布了该端口的 Postgres 容器名（不写死 greenhouse-postgres，改了 compose 也认得出） */
function pgContainer(port) {
  const r = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  for (const line of r.out.split('\n')) {
    const [name, ports] = line.split('\t');
    if (name && ports && ports.includes(`:${port}->5432/tcp`)) return name;
  }
  return null;
}

/** 在容器里跑 psql（-A -t：无表头无对齐，便于解析；容器内走 unix socket，免密） */
function psql(container, user, db, sql) {
  return sh('docker', ['exec', container, 'psql', '-U', user, '-d', db, '-Atc', sql]);
}

/**
 * 确保本地 Postgres 在跑。只碰 docker-compose.yml 的 postgres 服务（本机开发库），
 * 永远不碰 docker-compose.dev.yml（那是 dev 服务器的库）。
 */
async function ensureInfra(cfg) {
  if (!LOCAL_HOSTS.has(cfg.host)) {
    warn(`DATABASE_URL 指向非本机 ${cfg.host}:${cfg.port}——跳过 infra 托管，只做连通性检查`);
  } else if (!pgContainer(cfg.port)) {
    info('起本地 Postgres（docker compose up -d postgres）…');
    const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'postgres'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    if (r.status !== 0) {
      throw new Error('docker compose up postgres 失败（先看 docker info / docker context show，别急着重装运行时）');
    }
  }
  const container = pgContainer(cfg.port);
  for (let i = 0; i < 40; i++) {
    if (container) {
      if (sh('docker', ['exec', container, 'pg_isready', '-U', cfg.user]).code === 0) return container;
    } else {
      // 非容器 Postgres（本机装的 / 远端）：能建 TCP 连接就算就绪。
      const probe = sh('nc', ['-z', cfg.host, String(cfg.port)]);
      if (probe.code === 0) return null;
    }
    await sleep(500);
  }
  throw new Error(`Postgres ${cfg.host}:${cfg.port} 20 秒内未就绪`);
}

/** 库是否存在 */
function dbExists(container, user, name) {
  const r = psql(container, user, 'postgres', `select 1 from pg_database where datname = '${name}'`);
  return r.out === '1';
}

/**
 * 备好沙箱库：不存在则建（默认整库克隆主库，`--fresh` 建空库）。
 * 克隆优先用 CREATE DATABASE ... TEMPLATE（文件级拷贝，503MB 也就几秒），
 * 主库有活连接时该语句会被拒——回落到容器内 pg_dump | psql。
 */
function prepareSandboxDb(container, cfg, sandboxDb, fresh) {
  if (!container) {
    throw new Error('沙箱库需要本机 docker Postgres 容器（未找到发布该端口的容器）');
  }
  if (dbExists(container, cfg.user, sandboxDb)) {
    info(`复用沙箱库 ${sandboxDb}`);
    return;
  }
  if (fresh || !dbExists(container, cfg.user, cfg.db)) {
    info(`建空沙箱库 ${sandboxDb}`);
    const r = psql(container, cfg.user, 'postgres', `create database "${sandboxDb}"`);
    if (r.code !== 0) throw new Error(`建库失败：${r.err}`);
    return;
  }
  info(`克隆主库 ${cfg.db} → ${sandboxDb}（TEMPLATE 拷贝）…`);
  const tpl = psql(container, cfg.user, 'postgres', `create database "${sandboxDb}" template "${cfg.db}"`);
  if (tpl.code === 0) return;
  warn(`TEMPLATE 克隆被拒（多半是主库有活连接）：${tpl.err.split('\n')[0]}`);
  info('回落到 pg_dump | psql…');
  const created = psql(container, cfg.user, 'postgres', `create database "${sandboxDb}"`);
  if (created.code !== 0) throw new Error(`建库失败：${created.err}`);
  const dump = sh('docker', [
    'exec',
    container,
    'sh',
    '-c',
    `pg_dump -U ${cfg.user} -d ${cfg.db} | psql -q -U ${cfg.user} -d ${sandboxDb}`,
  ]);
  if (dump.code !== 0) {
    warn(`pg_dump 回落失败，沙箱库保持为空（migrate 会建全套 schema）：${dump.err.split('\n')[0]}`);
  }
}

/**
 * 应用迁移（沙箱库必跑：本分支新增的 migration 只有跑过才验得了）。
 * drizzle-kit 会把 `schema already exists` 之类的 NOTICE 整段打出来，噪声压进
 * .run-dev/logs/migrate.log，控制台只留结论；失败才把尾部贴出来。
 */
function runMigrate(dbUrl) {
  info('应用迁移（drizzle-kit migrate）…');
  const { file, fd } = openLog('migrate');
  const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, DATABASE_URL: dbUrl },
  });
  fs.closeSync(fd);
  if (r.status !== 0) {
    console.error(fs.readFileSync(file, 'utf8').split('\n').slice(-30).join('\n'));
    throw new Error(`drizzle-kit migrate 失败（全文 ${path.relative(ROOT, file)}）`);
  }
  info(`迁移完成 ✓（${path.relative(ROOT, file)}）`);
}

/** 主树模式不自动 migrate（那是用户自己的库），但要提醒有多少条没应用 */
function warnPendingMigrations(container, cfg, dbUrl) {
  const files = fs.readdirSync(path.join(ROOT, 'drizzle')).filter((f) => f.endsWith('.sql')).length;
  let applied = null;
  if (container) {
    const r = psql(container, cfg.user, cfg.db, 'select count(*) from drizzle.__drizzle_migrations');
    if (r.code === 0) applied = Number(r.out);
  }
  if (applied !== null && applied < files) {
    warn(
      `${cfg.db} 有 ${files - applied} 条迁移未应用 —— 需要时手动跑：DATABASE_URL=${dbUrl} pnpm exec drizzle-kit migrate`,
    );
  }
}

// ============================================================================
// 账号确保（库里一个 super 都没有才种；已有账号只提醒）
// ============================================================================
function cliJson(args, dbUrl) {
  const r = sh('pnpm', ['cli', ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl } });
  // CLI 会先打自己的启动噪声，截出 JSON 段再解析。
  const start = r.out.indexOf('[');
  const end = r.out.lastIndexOf(']');
  if (r.code !== 0 || start < 0 || end < start) return null;
  try {
    return JSON.parse(r.out.slice(start, end + 1));
  } catch {
    return null;
  }
}

function ensureAccount(dbUrl) {
  const users = cliJson(['users', 'list', '--json'], dbUrl);
  if (users === null) {
    warn('读取用户列表失败（库没 migrate？）——跳过账号确保');
    return { seeded: false, supers: [] };
  }
  const supers = users.filter((u) => u.role === 'super' && u.status === 'active').map((u) => u.email);
  if (supers.length) return { seeded: false, supers };

  info(`库里没有 super —— 种一个本地账号 ${SEED_EMAIL}…`);
  const r = spawnSync(
    'pnpm',
    [
      'cli',
      'users',
      'create',
      '--email',
      SEED_EMAIL,
      '--password',
      SEED_PASSWORD,
      '--nickname',
      SEED_NICKNAME,
      '--role',
      'super',
    ],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  if (r.status !== 0) throw new Error('users create 失败');
  return { seeded: true, supers: [SEED_EMAIL] };
}

// ============================================================================
// worktree 自举：装依赖 + 拷 .env
// ============================================================================
/**
 * worktree 里 `pnpm install` 而不是 symlink 主树 node_modules：本仓库的 workspace 包
 * 直接导出 `src/*.ts`（无 dist），symlink 过来会让 `@greenhouse/*` 解析到**主树源码**，
 * 等于验错代码。热 store 下装一遍只要十几秒，正确性换得起。
 */
function bootstrapWorktree() {
  const main = mainTreeRoot();
  if (main === ROOT) return;
  const envDst = path.join(ROOT, '.env');
  if (!fs.existsSync(envDst) && fs.existsSync(path.join(main, '.env'))) {
    fs.copyFileSync(path.join(main, '.env'), envDst);
    info('已从主树拷贝 .env（TOKEN_SIGNING_KEY 等守卫缺了 api 起不来）');
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    info('worktree 无 node_modules —— pnpm install（热 store 约十几秒）…');
    const r = spawnSync('pnpm', ['install', '--prefer-offline'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('pnpm install 失败');
  }
}

// ============================================================================
// up
// ============================================================================
async function cmdUp(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const target = argv.find((a) => !a.startsWith('--')) || 'all';
  if (!TARGETS[target]) throw new Error(`未知 target：${target}（可选 ${Object.keys(TARGETS).join('/')}）`);

  const prev = readState();
  if (prev && Object.keys(prev.services || {}).length) {
    warn('已有 state（上次没 stop？）—— 先 `node scripts/run-dev.mjs stop` 再 up');
    throw new Error('state 已存在');
  }

  bootstrapWorktree();

  // 1. 数据面：主树用 .env 的库，worktree（或 --sandbox）用独立沙箱库
  const fileEnv = readEnvFile(path.join(ROOT, '.env'));
  const cfg = parseDbUrl(process.env.DATABASE_URL || fileEnv.DATABASE_URL || DEFAULT_DB_URL);
  const sandbox = flags.has('--sandbox') || isWorktree();
  const dbNameFlag = argv.find((a) => a.startsWith('--db='))?.slice(5);
  const sandboxDb = dbNameFlag || `${SANDBOX_DB_PREFIX}${worktreeSlug()}`;
  const dbUrl = sandbox ? buildDbUrl(cfg, sandboxDb) : buildDbUrl(cfg);

  const state = {
    mode: sandbox ? 'sandbox' : 'main',
    root: ROOT,
    target,
    db: sandbox ? sandboxDb : cfg.db,
    dbUrl,
    services: {},
    createdAt: new Date().toISOString(),
  };
  writeState(state);

  const container = await ensureInfra(cfg);
  if (sandbox) {
    prepareSandboxDb(container, cfg, sandboxDb, flags.has('--fresh'));
    runMigrate(dbUrl);
  } else {
    warnPendingMigrations(container, cfg, dbUrl);
  }

  // 2. 端口分配（一次算好，web→api 的 env 联动都用它）
  const selected = TARGETS[target];
  const ports = {};
  for (const name of selected) ports[name] = await allocatePort(name);
  state.ports = ports;
  writeState(state);

  if (flags.has('--mission')) {
    const image =
      process.env.SANDBOX_RUNNER_IMAGE ||
      process.env.CLOUD_AGENT_IMAGE ||
      fileEnv.SANDBOX_RUNNER_IMAGE ||
      fileEnv.CLOUD_AGENT_IMAGE ||
      'greenhouse/agent-runtime:latest';
    ensureMissionInfra(state, image);
  }

  // 3. api 先行（web 的 Vite 代理指向它）
  const apiEnv = {
    API_PORT: String(ports.api),
    DATABASE_URL: dbUrl,
    // Account setup/reset links must return to the actual dynamically allocated
    // local web origin, not a stale port copied from .env.
    ...(ports.web ? { PUBLIC_BASE_URL: `http://localhost:${ports.web}` } : {}),
    // run-dev is always a local development process. This also selects the
    // monitor-only workspace quota posture instead of production attestation.
    NODE_ENV: 'development',
    ...(state.mission
      ? {
          MISSION_ENABLED: '1',
          SANDBOX_RUNNER_ALLOW_UNHARDENED: '1',
          SANDBOX_RUNNER_DOCKER_RUNTIME: 'runc',
          SANDBOX_RUNNER_IMAGE: state.mission.image,
          SANDBOX_RUNNER_NETWORK: state.mission.network,
          SANDBOX_RUNNER_API_BASE: `http://host.docker.internal:${ports.api}`,
          SANDBOX_RUNNER_DATA_ROOT: state.mission.dataRoot,
        }
      : {}),
  };
  launch(state, 'api', 'pnpm', ['api'], apiEnv, ports.api);
  if (!(await waitHealthy('api', ports.api))) {
    throw new Error('api 健康检查超时，查 .run-dev/logs/api.log');
  }
  info('api 健康 ✓');
  if (state.mission) await assertMissionReady(state, ports.api);

  // 4. 账号确保（api 起来了说明库是通的）
  const account = ensureAccount(dbUrl);
  state.account = account;
  writeState(state);

  // 5. web（Vite 的 port 写死在 vite.config.ts，只能命令行覆盖；API_PORT 决定代理目标）
  if (selected.includes('web')) {
    launch(
      state,
      'web',
      'pnpm',
      ['--filter', '@greenhouse/web', 'exec', 'vite', '--port', String(ports.web), '--strictPort'],
      { API_PORT: String(ports.api) },
      ports.web,
    );
    if (!(await waitHealthy('web', ports.web))) {
      printSummary(state);
      throw new Error('web 健康检查超时，查 .run-dev/logs/web.log');
    }
    info('web 健康 ✓');
  }

  printSummary(state);
}

// ============================================================================
// stop
// ============================================================================
async function cmdStop(argv) {
  const flags = new Set(argv);
  const state = readState();
  if (!state) {
    warn('无 state（本树没有 run-dev 拉起的服务）');
  } else {
    for (const [name, svc] of Object.entries(state.services || {})) {
      const cmd = sh('ps', ['-p', String(svc.pid), '-o', 'command=']).out;
      if (!cmd) {
        info(`${name} 已不在（pid=${svc.pid}）`);
        continue;
      }
      if (svc.marker && !cmd.includes(svc.marker)) {
        warn(`${name} pid=${svc.pid} 命令行不匹配（疑 pid 复用），跳过：${cmd.slice(0, 60)}`);
        continue;
      }
      try {
        process.kill(-svc.pgid, 'SIGTERM');
        info(`停 ${name}（pgid=${svc.pgid}）`);
      } catch {
        /* 组已消亡 */
      }
    }
    await sleep(3000); // 给 pnpm/vite 子进程退出的时间
    for (const [name, svc] of Object.entries(state.services || {})) {
      if (sh('ps', ['-p', String(svc.pid), '-o', 'command=']).out) {
        warn(`${name} 未退，SIGKILL`);
        try {
          process.kill(-svc.pgid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    }
    stopMissionInfra(state);
  }

  // Postgres 容器不关：主树、别的 worktree、别的项目都连着它（本地库是共用基建）。
  if (flags.has('--wipe')) {
    const db = state?.db;
    if (state?.mode !== 'sandbox' || !db?.startsWith(SANDBOX_DB_PREFIX)) {
      warn(`--wipe 只对 ${SANDBOX_DB_PREFIX}* 沙箱库生效，当前库 ${db ?? '未知'} 保持原样`);
    } else {
      const cfg = parseDbUrl(state.dbUrl);
      const container = pgContainer(cfg.port);
      if (!container) warn('未找到 Postgres 容器，沙箱库未删');
      else {
        const r = psql(container, cfg.user, 'postgres', `drop database if exists "${db}" with (force)`);
        if (r.code === 0) info(`已删沙箱库 ${db}`);
        else warn(`删库失败：${r.err.split('\n')[0]}`);
      }
    }
  } else if (state?.mode === 'sandbox') {
    info(`沙箱库 ${state.db} 保留（下次 up 秒起；要归零加 --wipe）`);
  }

  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
  info('stop 完成（Postgres 容器共用不关；日志保留在 .run-dev/logs/）');
}

// ============================================================================
// status + 摘要输出
// ============================================================================
/** 显示宽度：CJK/全角算两列，否则中文单元格一多整张表就错位 */
const displayWidth = (s) =>
  [...String(s ?? '')].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

function table(rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const width = keys.map((k) => Math.max(displayWidth(k), ...rows.map((r) => displayWidth(r[k]))));
  const pad = (v, w) => String(v ?? '') + ' '.repeat(Math.max(0, w + 2 - displayWidth(v)));
  const line = (vals) => '  ' + vals.map((v, i) => pad(v, width[i])).join('');
  console.log(line(keys));
  console.log(line(width.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(keys.map((k) => r[k])));
}

function printSummary(state) {
  const rows = Object.entries(state.services).map(([name, s]) => ({
    service: name,
    port: s.port ?? '-',
    url: s.port ? `http://localhost:${s.port}` : '-',
    alive: sh('ps', ['-p', String(s.pid), '-o', 'command=']).out ? '✓' : '✗',
    log: s.log,
  }));
  console.log('');
  info(`服务（mode=${state.mode}）：`);
  table(rows);

  const cfg = parseDbUrl(state.dbUrl);
  const container = pgContainer(cfg.port);
  const stats = container ? sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']) : null;
  const memLine = stats?.out.split('\n').find((l) => l.startsWith(`${container}\t`));
  console.log('');
  info('数据库：');
  table([
    {
      db: state.db,
      mode: state.mode === 'sandbox' ? '沙箱（本 worktree 独占）' : '主库（.env）',
      container: container ?? '（非容器）',
      mem: memLine?.split('\t')[1] ?? '-',
    },
  ]);

  if (state.mission) {
    console.log('');
    info('Mission：');
    table([
      {
        admission: state.mission.health?.state ?? 'pending',
        runtime: state.mission.health?.isolation?.runtime ?? 'runc（本地）',
        quota: state.mission.health?.isolation?.workspace_quota?.mode ?? 'monitor-only',
        network: state.mission.network,
        image: state.mission.image,
      },
    ]);
  }

  console.log('');
  if (state.account?.seeded) {
    info(`登录账号（新种）：${C.c}${SEED_EMAIL} / ${SEED_PASSWORD}${C.x}`);
  } else if (state.account?.supers?.length) {
    info(`super 账号：${C.c}${state.account.supers.join(', ')}${C.x}`);
    console.log(
      `  ${C.d}密码见 docs/local/test-accounts.md（gitignored）；不知道就用 TOKEN_SIGNING_KEY 自签 token${C.x}`,
    );
  }
  console.log(`  ${C.d}收摊：node scripts/run-dev.mjs stop${C.x}`);
}

function cmdStatus() {
  const state = readState();
  if (state) {
    printSummary(state);
    return;
  }
  info('无 state。基准端口现况：');
  table(
    Object.entries(SERVICES).map(([name, s]) => {
      const holder = listenerOnPort(s.base);
      return {
        service: name,
        port: s.base,
        holder: holder ? `${holder.pid} ${(holder.command || '').slice(0, 50)}` : '（空闲）',
        cwd: holder?.cwd || '-',
      };
    }),
  );
}

// ============================================================================
// main
// ============================================================================
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'up') await cmdUp(rest);
  else if (cmd === 'stop') await cmdStop(rest);
  else if (cmd === 'status') cmdStatus();
  else {
    console.log(
      '用法: node scripts/run-dev.mjs {up [all|web|api] [--sandbox|--fresh|--mission|--db=<name>] | stop [--wipe] | status}',
    );
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  fail(e.message);
  process.exit(1);
}
