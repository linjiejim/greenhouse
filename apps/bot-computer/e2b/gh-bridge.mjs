// gh-bridge — the door into a hosted (E2B-protocol) computer for the greenhouse API.
//
// A docker computer is reached through `docker exec`; a hosted sandbox has no such
// thing, so two of these run inside it under systemd (apps/bot-computer/e2b/systemd/):
//
//   gh-bridge-browser  uid browser  :7681  /vnc /cdp (the 0600 sockets in /tmp/browser) + /exec
//   gh-bridge-agent    uid agent    :7682  /exec (the Bots' shell, the member's terminal, files)
//
// Each serves a 127.0.0.1 port that PID 1 holds (systemd socket units, bound while the
// template was built): the port is never free, so no other uid can listen there and
// collect the secret the API sends. The provider's edge forwards the port to
// `<port>-<sandbox>.<domain>` behind its own traffic token (only the API has it), and
// every WebSocket upgrade must also carry this uid's secret (`x-gh-bridge-secret`,
// compared in constant time against GH_BRIDGE_SECRET_FILE, 0400 to this uid) before
// anything is opened or spawned: the agent uid can reach loopback too, and must never
// get into the browser side. The agent bridge's secret is readable by the agent uid —
// by design: it only ever runs things as agent, which the Bots already do.
//
// GH_BRIDGE_REQUIRE_SOCKET=1 (the units): serve only the socket systemd passes (fd 3),
// never bind a port. Without it (tests) GH_BRIDGE_PORT is bound on 127.0.0.1.
//
// /vnc, /cdp   raw bytes in both directions (binary frames ⇄ the Unix socket).
// /exec        the first message is text: {"argv":[…],"cwd":"/…","env":{…}}; then
//                client → binary = stdin bytes; text {"t":"eof"} closes stdin,
//                         {"t":"kill","signal":"SIGKILL"} signals the process;
//                server → binary = one channel byte (1 stdout, 2 stderr) + data;
//                         text {"t":"exit","code":N,"signal":S|null} once it has exited
//                         and its output is sent, then a normal close.
//              A client that goes away mid-run ends stdin and stops reading the output
//              (the process then gets EOF / EPIPE, as with a dropped `docker exec`); it is
//              not killed — the API kills what it means to (shell.ts KILL_SCRIPT).

import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.GH_BRIDGE_PORT);
const REQUIRE_SOCKET = process.env.GH_BRIDGE_REQUIRE_SOCKET === '1';
/** sd_listen_fds(3): the listening socket systemd handed to this very process. */
const SYSTEMD_SOCKET = process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid);
const SECRET_FILE = process.env.GH_BRIDGE_SECRET_FILE ?? '';
const TUNNELS = process.env.GH_BRIDGE_TUNNELS === '1';
const READY_FILE = process.env.GH_BRIDGE_READY_FILE ?? '';
/** Where gh-computer puts the browser's sockets (overridable for tests). */
const SOCKET_DIR = process.env.GH_BRIDGE_SOCKET_DIR || '/tmp/browser';
const SOCKETS = { '/vnc': `${SOCKET_DIR}/vnc.sock`, '/cdp': `${SOCKET_DIR}/cdp.sock` };
/** DevTools messages carry file uploads. */
const MAX_PAYLOAD = 256 * 1024 * 1024;
/** Stop reading a source while this much is queued towards the client. */
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PING_MS = 20_000;
const CHANNEL = { stdout: 1, stderr: 2 };

if (!SECRET_FILE) {
  console.error('gh-bridge: GH_BRIDGE_SECRET_FILE is required');
  process.exit(2);
}
if (!SYSTEMD_SOCKET && (REQUIRE_SOCKET || !Number.isInteger(PORT) || PORT <= 0)) {
  // Binding a port ourselves would leave it free across a restart — exactly what the socket unit prevents.
  console.error('gh-bridge: no listening socket from systemd (and binding a port is not allowed here)');
  process.exit(2);
}

// What every spawned process inherits: the unit's environment, without our own knobs or systemd's fds.
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GH_BRIDGE_') && !key.startsWith('LISTEN_')),
);

function secretOk(given) {
  let expected = '';
  try {
    expected = readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    return false;
  }
  if (expected.length < 32 || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pause `source` while the socket's send queue is long; resume once it drained. */
function sendWithBackpressure(ws, data, source) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(data, { binary: true }, () => {
    if (source.isPaused?.() && ws.bufferedAmount < LOW_WATER) source.resume();
  });
  if (ws.bufferedAmount > HIGH_WATER) source.pause();
}

function keepAlive(ws) {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }, PING_MS);
  ws.on('close', () => clearInterval(timer));
}

function tunnel(ws, path) {
  const unix = connect(SOCKETS[path]);
  const close = () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    unix.destroy();
  };
  unix.on('data', (chunk) => sendWithBackpressure(ws, chunk, unix));
  ws.on('message', (data) => {
    if (!unix.write(data)) {
      ws.pause();
      unix.once('drain', () => ws.resume());
    }
  });
  unix.on('close', close);
  unix.on('error', close);
  ws.on('close', () => unix.destroy());
  ws.on('error', () => unix.destroy());
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

function validSpec(spec) {
  if (!spec || typeof spec !== 'object' || !isStringArray(spec.argv)) return false;
  if (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/'))) return false;
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) return false;
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') return false;
    }
  }
  return true;
}

function exec(ws) {
  let child = null;
  let finished = false;
  let pendingInput = [];
  let eof = false;

  const send = (channel, chunk, source) =>
    sendWithBackpressure(ws, Buffer.concat([Buffer.from([channel]), chunk]), source);
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    if (ws.readyState === ws.OPEN) {
      // Paused for stdin backpressure, the socket would never read the client's close frame.
      if (ws.isPaused) ws.resume();
      ws.send(JSON.stringify({ t: 'exit', code, signal }));
      ws.close(1000);
    }
  };
  const fail = (code, message) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([CHANNEL.stderr]), Buffer.from(`${message}\n`)]));
    finish(code, null);
  };
  const writeInput = (data) => {
    if (!child) {
      pendingInput.push(data);
      return;
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    if (!child.stdin.write(data)) {
      ws.pause();
      child.stdin.once('drain', () => ws.resume());
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeInput(data);
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      ws.close(1008, 'bad message');
      return;
    }
    if (!child && !finished) {
      start(message);
      return;
    }
    if (!child) return;
    if (message?.t === 'eof') {
      eof = true;
      child?.stdin.end();
    } else if (message?.t === 'kill') {
      try {
        child?.kill(typeof message.signal === 'string' ? message.signal : 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  function start(spec) {
    if (!validSpec(spec)) {
      finished = true;
      ws.close(1008, 'bad exec spec');
      return;
    }
    const cwd = spec.cwd ?? process.env.HOME ?? '/';
    let cwdOk = false;
    try {
      cwdOk = existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      cwdOk = false;
    }
    if (!cwdOk) {
      // What `docker exec -w <missing>` amounts to: the command never runs.
      fail(126, `gh-bridge: cannot change to ${cwd}: no such directory`);
      return;
    }
    try {
      child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd,
        env: { ...BASE_ENV, ...(spec.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      fail(127, `gh-bridge: ${err.message}`);
      return;
    }
    child.stdin.on('error', () => {});
    // A process that stops reading (it exited, or closed stdin) must not leave the socket paused.
    child.stdin.on('close', () => {
      if (ws.isPaused) ws.resume();
    });
    child.on('error', (err) => {
      // ENOENT and friends: the process never started.
      fail(err.code === 'ENOENT' ? 127 : 126, `gh-bridge: ${spec.argv[0]}: ${err.message}`);
    });
    child.stdout.on('data', (chunk) => send(CHANNEL.stdout, chunk, child.stdout));
    child.stderr.on('data', (chunk) => send(CHANNEL.stderr, chunk, child.stderr));
    // A broken pipe on one process must never take the bridge (and every other session) down.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    // 'close' waits for stdout and stderr to end, so the exit is the last frame.
    child.on('close', (code, signal) => finish(code, signal));
    for (const data of pendingInput) writeInput(data);
    pendingInput = [];
    if (eof) child.stdin.end();
  }

  ws.on('close', () => {
    if (!child || finished) return;
    // The API went away: no more input, and nobody reads the output.
    child.stdin.end();
    child.stdout.destroy();
    child.stderr.destroy();
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
const server = createServer((_req, res) => {
  res.writeHead(404).end();
});

server.on('upgrade', (req, socket, head) => {
  let path;
  try {
    path = new URL(req.url ?? '/', 'http://bridge').pathname;
  } catch {
    path = '';
  }
  const allowed = path === '/exec' || (TUNNELS && path in SOCKETS);
  if (!allowed || !secretOk(req.headers['x-gh-bridge-secret'])) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    keepAlive(ws);
    if (path === '/exec') exec(ws);
    else tunnel(ws, path);
  });
});

// Fail closed: a bridge that cannot serve its socket exits (systemd restarts it on the same socket).
server.on('error', (err) => {
  console.error(`gh-bridge: ${err.message}`);
  process.exit(1);
});
const onListening = () => {
  if (READY_FILE) writeFileSync(READY_FILE, '');
  const where = SYSTEMD_SOCKET ? 'the socket from systemd' : `127.0.0.1:${PORT}`;
  console.error(`gh-bridge: serving ${where}${TUNNELS ? ' (tunnels on)' : ''}`);
};
if (SYSTEMD_SOCKET) server.listen({ fd: 3 }, onListening);
else server.listen(PORT, '127.0.0.1', onListening);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
