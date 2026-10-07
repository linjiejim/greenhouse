#!/usr/bin/env bash
# Smoke test of the greenhouse/bot-computer image with the API's exact
# `docker run` argv (docs/specs/20261005-personal-assistant-bots.md §6, §12;
# image contract 2: docs/specs/20261007-bots-computer-p0-p1.md §1):
#
#   1. starts with the real argv and answers DevTools (through gh-cdp-relay) in ≤45 s
#   2. VNC greets on the Unix socket; nothing listens on TCP
#   3. the agent uid cannot reach cdp.sock, vnc.sock, the X display or the profile
#   4. file:// and greenhouse's own origins are blocked; the welcome page is not
#   5. a timed-out command leaves no process behind (the API's exec wrapper + kill script)
#   6. relay hand-off: after a client vanishes mid-auto-attach, the next client
#      can open and drive a new target without hanging
#   7. desktop: openbox, tint2 and the window watchdog run, the maximized browser
#      leaves the panel free; WebGL works in the real browser; the browser speaks
#      the member's language (GH_COMPUTER_LANG, default zh-CN)
#   8. gh-window: a minimised browser comes back by itself (watchdog) and at once
#      (`gh-window restore`); `gh-window new` opens a window in the running browser
#   9. the agent's tools (pip, node, npm, ffmpeg, pandoc, sqlite3, …) and user-level
#      installs: pip and npm -g land in the home volume (local packages, no network)
#  10. gh-jobs: start / list / log / running / sids / stop, exit codes; a job outlives
#      the shell call that started it
#  11. gh-term: the API's framing through `docker exec -i` — resize + echo round
#      trip, and a reconnect lands in the same shell
#  12. gh-agent-kill (take-over) spares a job, a gh-term session (and what runs in
#      it) and tmux, but kills stray processes
#  13. the home volume (files, browser cookies, pip/npm installs) survives docker
#      stop + rm + a fresh run; a job cut off by it reads `lost`; the browser
#      follows a changed GH_COMPUTER_LANG (en-US) on the same profile
#  14. (hardened hosts) egress lockdown: from inside, the bridge gateway's API port and
#      cloud metadata are refused — the same probe the API runs after every start
#
# Usage: bash scripts/bot-computer-smoke.sh   (BOTS_COMPUTER_RUNTIME=runsc on a gVisor host;
# defaults to runc for a development box). BOTS_COMPUTER_IMAGE picks the image
# (default greenhouse/bot-computer:latest). Cleans up everything it creates.
# BOTS_COMPUTER_NETWORK=<the computers' bridge> runs on that network (it is never
# created or removed here) and adds check 14; apply the rules first with
# `sudo BOTS_COMPUTER_NETWORK=<net> bash scripts/cloud-agent-net.sh --profile bots`.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME="${BOTS_COMPUTER_RUNTIME:-runc}"
# scripts/bot-computer-argv.ts reads the same variable, so the argv names this image.
export BOTS_COMPUTER_IMAGE="${BOTS_COMPUTER_IMAGE:-greenhouse/bot-computer:latest}"
IMAGE="$BOTS_COMPUTER_IMAGE"
ID="smoke$$"
NAME="gh-computer-${ID}"
VOLUME="${NAME}-home"
OWN_NETWORK=1
NETWORK="gh-bots-${ID}"
if [ -n "${BOTS_COMPUTER_NETWORK:-}" ]; then
  OWN_NETWORK=0
  NETWORK="$BOTS_COMPUTER_NETWORK"
fi
BLOCKLIST="smoke-blocked.example,host.docker.internal:4401"
TSX=(node_modules/.bin/tsx scripts/bot-computer-argv.ts)

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() {
  printf '  \033[31m✗\033[0m %s\n' "$*"
  docker logs "$NAME" 2>&1 | grep -E '^\[gh-' | tail -20 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  if [ "$OWN_NETWORK" = 1 ]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# DevTools client run INSIDE the container as uid browser (the API's position).
# Commands: version | nav <url>... | setcookie | getcookie | attach-and-vanish |
# drive-new-target | webgl | languages
CDP_PY=$(cat <<'PY'
import json, socket, sys, time
sock = socket.socket(socket.AF_UNIX); sock.settimeout(10); sock.connect('/tmp/browser/cdp.sock')
buf = b''; counter = [0]; events = []
def send(method, params=None, session=None):
    counter[0] += 1
    msg = {'id': counter[0], 'method': method, 'params': params or {}}
    if session: msg['sessionId'] = session
    sock.sendall(json.dumps(msg).encode() + b'\0')
    return counter[0]
def wait(i):
    global buf
    while True:
        while b'\0' in buf:
            raw, buf = buf.split(b'\0', 1)
            obj = json.loads(raw)
            if obj.get('id') == i:
                return obj
            if 'method' in obj:
                events.append(obj)
        chunk = sock.recv(1 << 20)
        if not chunk:
            raise SystemExit('relay closed the connection')
        buf += chunk
def call(method, params=None, session=None):
    return wait(send(method, params, session))
def evaluate_in_new_tab(expression):
    # A tab of the real, windowed browser (not a headless target).
    target = call('Target.createTarget', {'url': 'about:blank'})['result']['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
    value = call('Runtime.evaluate', {'expression': expression, 'returnByValue': True}, session)['result']['result'].get('value')
    call('Target.closeTarget', {'targetId': target})
    return value
cmd = sys.argv[1]
if cmd == 'version':
    print(call('Browser.getVersion')['result']['product'])
elif cmd == 'nav':
    target = call('Target.createTarget', {'url': 'about:blank'})['result']['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
    for url in sys.argv[2:]:
        result = call('Page.navigate', {'url': url}, session).get('result', {})
        print(url, result.get('errorText') or 'loaded')
    call('Target.closeTarget', {'targetId': target})
elif cmd == 'setcookie':
    call('Storage.setCookies', {'cookies': [{'name': 'gh_smoke', 'value': 'kept', 'domain': '.example.com', 'path': '/', 'expires': time.time() + 86400}]})
    print('set')
elif cmd == 'getcookie':
    print(' '.join(c['name'] for c in call('Storage.getCookies')['result']['cookies']))
elif cmd == 'attach-and-vanish':
    # What Playwright does on connect, then the client dies without cleaning up.
    call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True})
    call('Target.setDiscoverTargets', {'discover': True})
    call('Target.createTarget', {'url': 'about:blank'})
    time.sleep(0.5)
    print('vanished')
elif cmd == 'drive-new-target':
    # What Playwright needs after the hand-off: the existing pages are announced
    # to the new client, and a new tab actually loads (not paused for a dead debugger).
    started = time.time()
    call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': False, 'flatten': True})
    call('Browser.getVersion')  # a round trip, so the attach events have arrived
    pages = sum(1 for e in events if e['method'] == 'Target.attachedToTarget' and e['params']['targetInfo']['type'] == 'page')
    target = call('Target.createTarget', {'url': 'file:///opt/greenhouse/welcome.html'})['result']['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
    title = ''
    while time.time() - started < 8 and 'greenhouse' not in title:
        title = call('Runtime.evaluate', {'expression': 'document.title', 'returnByValue': True}, session)['result']['result'].get('value', '')
        time.sleep(0.1)
    call('Target.closeTarget', {'targetId': target})
    print(f'pages={pages} loaded={"greenhouse" in title} in {time.time() - started:.2f}s')
elif cmd == 'webgl':
    print(evaluate_in_new_tab("""(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'none';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })()"""))
elif cmd == 'languages':
    print(','.join(evaluate_in_new_tab('navigator.languages')))
PY
)
cdp() { docker exec -i -u browser "$NAME" python3 - "$@" <<<"$CDP_PY"; }

# The member's terminal, driven exactly like the API's WebSocket tunnel: frames
# (type u8, length u32 BE, payload) into `docker exec -i … gh-term`, raw PTY
# output back. Modes: roundtrip | reattach | kill (runs gh-agent-kill while the
# terminal is open and proves it still answers).
TERM_JS=$(cat <<'JS'
const { spawn, execFileSync } = require('node:child_process');
const [container, mode] = process.argv.slice(1);
const frame = (type, payload) => {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
const term = spawn('docker', ['exec', '-i', '-u', 'agent', '-e', 'HOME=/home/agent', '-w', '/home/agent/work', container, 'gh-term']);
let out = '';
let exited = null;
term.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
term.stderr.on('data', (chunk) => process.stderr.write(chunk));
term.on('exit', (code) => { exited = code; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (text) => term.stdin.write(frame(0, text));
const resize = (cols, rows) => term.stdin.write(frame(1, JSON.stringify({ cols, rows })));
async function expect(re, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(50)) {
    const match = out.match(re);
    if (match) return match;
    if (exited !== null) throw new Error(`gh-term exited (${exited}) before ${re}`);
  }
  throw new Error(`no ${re} within ${ms} ms; last output: ${JSON.stringify(out.slice(-300))}`);
}
// Markers around $(…) never appear in the echoed command line, only in the result.
async function run(command, re) {
  out = '';
  type(`${command}\r`);
  return expect(re);
}
async function close() {
  term.stdin.end();
  for (const until = Date.now() + 5000; exited === null && Date.now() < until; ) await sleep(50);
  return exited;
}
(async () => {
  resize(123, 45);
  await expect(/\$ /); // the shell's prompt: tmux and bash are up
  const result = [];
  if (mode === 'roundtrip') {
    const [, rows, cols] = await run('echo SZ$(stty size)ZS', /SZ(\d+) (\d+)ZS/);
    result.push(`size=${cols}x${rows}`);
    await run('echo RT$((6*7))TR', /RT42TR/);
    resize(100, 30);
    await sleep(300);
    const [, rows2, cols2] = await run('echo SZ$(stty size)ZS', /SZ(\d+) (\d+)ZS/);
    result.push(`resized=${cols2}x${rows2}`);
    await run('export GH_SMOKE_MARK=kept-$((40+2)); echo OK$((1+1))KO', /OK2KO/);
  } else if (mode === 'reattach') {
    await run('echo MK${GH_SMOKE_MARK}KM', /MKkept-42KM/);
    result.push('same-shell=yes');
  } else if (mode === 'kill') {
    const [, pid] = await run('sleep 3001 & echo BG$!GB', /BG(\d+)GB/);
    result.push(`terminal-child=${pid}`);
    const killed = execFileSync('docker', ['exec', '-u', 'agent', container, 'gh-agent-kill'], { encoding: 'utf8' }).trim();
    result.push(`killed=${killed}`);
    await run('echo AL$((1+1))VE', /AL2VE/);
    result.push('terminal-alive=yes');
  }
  result.push(`exit=${await close()}`);
  console.log(result.join(' '));
})().catch((err) => {
  console.error(err.message);
  term.kill();
  process.exit(1);
});
JS
)
terminal() { node -e "$TERM_JS" "$NAME" "$1"; }

# `lines_into ARR cmd…` — one array element per output line (macOS bash 3.2 has no mapfile).
lines_into() {
  local __name=$1 __line
  shift
  eval "$__name=()"
  while IFS= read -r __line; do eval "$__name+=(\"\$__line\")"; done < <("$@")
}
as_agent() { docker exec -u agent -e HOME=/home/agent "$NAME" bash -c "$1"; }
# A login shell, like the API's shell tool (`bash -lc`): /etc/profile.d applies.
as_agent_login() { docker exec -u agent -e HOME=/home/agent -w /home/agent "$NAME" bash -lc "$1"; }
# The display's owner, with the env the API's desktop calls pass.
as_browser() { docker exec -u browser -e XAUTHORITY=/home/browser/.Xauthority "$NAME" "$@"; }
# gh-jobs exactly as the API calls it: argv, uid agent, no shell.
jobs_cli() { docker exec -u agent -e HOME=/home/agent -w /home/agent "$NAME" gh-jobs "$@"; }
# jq inside the image — the host may not have it.
json() { docker exec -i "$NAME" jq -r "$1"; }

# `start_computer [docker run options…]` — the API's argv; extra options go
# where the API puts its own optional ones (just before the image).
start_computer() {
  lines_into RUN_ARGS "${TSX[@]}" run "$NAME" "$VOLUME" "$NETWORK" "$RUNTIME" "$BLOCKLIST"
  local last=$((${#RUN_ARGS[@]} - 1))
  if [ "$#" -gt 0 ]; then RUN_ARGS=("${RUN_ARGS[@]:0:$last}" "$@" "${RUN_ARGS[$last]}"); fi
  docker "${RUN_ARGS[@]}" >/dev/null  # the argv starts with `run`
  local deadline=$((SECONDS + 45))
  until cdp version >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then fail "DevTools did not answer within 45 s"; fi
    sleep 0.5
  done
}

# `wait_until SECONDS cmd…` — poll until cmd succeeds; prints how long it took.
wait_until() {
  local limit=$1 started=$SECONDS
  shift
  until "$@" >/dev/null 2>&1; do
    if [ $((SECONDS - started)) -ge "$limit" ]; then return 1; fi
    sleep 0.25
  done
  echo $((SECONDS - started))
}

echo "==> bot-computer smoke (image: ${IMAGE}, runtime: ${RUNTIME})"
contract=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "greenhouse.bots.computer.contract"}}')
[ "$contract" = 2 ] || fail "image speaks contract ${contract:-none}; this smoke tests contract 2"
if [ "$OWN_NETWORK" = 1 ]; then
  docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false \
    --label greenhouse.bots.computer=smoke "$NETWORK" >/dev/null
fi

# 1. start + DevTools
t0=$SECONDS
start_computer
pass "started with the API argv; DevTools answers: $(cdp version) ($((SECONDS - t0)) s)"
lines_into RUN_ARGS "${TSX[@]}" run "$NAME" "$VOLUME" "$NETWORK" "$RUNTIME" "$BLOCKLIST"
printf '%s\n' "${RUN_ARGS[@]}" | grep -qx -- '-p' && fail "argv publishes a port"
[ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$NAME")" = "{}" ] || fail "container has port bindings"
docker exec "$NAME" env | grep -qE '^(HTTP|HTTPS)_PROXY=.+' && fail "a proxy leaked into the container env"
pass "no published ports; proxy env cleared"

# 2. VNC on the socket only
greeting=$(docker exec -i -u browser "$NAME" timeout 3 socat -T2 STDIO UNIX-CONNECT:/tmp/browser/vnc.sock </dev/null 2>/dev/null | head -c 12 || true)
[ "$greeting" = "RFB 003.008" ] || fail "no VNC greeting on vnc.sock (got: ${greeting:-nothing})"
pass "VNC greets on the Unix socket: ${greeting}"
for port in 5900 9222; do
  if as_agent "timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}'" 2>/dev/null; then fail "TCP ${port} is open"; fi
done
# State 0A = LISTEN. Docker's embedded DNS (127.0.0.11 = 0B00007F, on user-defined
# networks) listens inside the container's namespace but belongs to dockerd.
listening=$(docker exec "$NAME" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' |
  awk '$4 == "0A" && $2 !~ /^0B00007F:/' | wc -l | tr -d ' ')
[ "$listening" = 0 ] || fail "${listening} TCP socket(s) listening in the container"
pass "no process in the container listens on TCP"

# 3. the agent uid is walled off
if as_agent "timeout 3 socat -T1 - UNIX-CONNECT:/tmp/browser/cdp.sock </dev/null" 2>/dev/null; then fail "agent reached cdp.sock"; fi
if as_agent "timeout 3 socat -T1 - UNIX-CONNECT:/tmp/browser/vnc.sock </dev/null" 2>/dev/null; then fail "agent reached vnc.sock"; fi
if as_agent "DISPLAY=:0 timeout 3 xsetroot -solid red" 2>/dev/null; then fail "agent drew on the X display"; fi
if as_agent "DISPLAY=:0 timeout 3 xdotool getactivewindow" >/dev/null 2>&1; then fail "agent reached the X display through xdotool"; fi
if as_agent "ls /home/browser" >/dev/null 2>&1; then fail "agent listed the browser profile"; fi
if as_agent "cat /home/browser/.Xauthority" >/dev/null 2>&1; then fail "agent read the X cookie"; fi
as_agent "curl -sS -o /dev/null -m 15 --retry 3 --retry-all-errors https://cn.bing.com/" >/dev/null || fail "agent has no internet"
pass "agent: cdp.sock, vnc.sock, X display, X cookie and profile denied; internet works"

# 4. URL policy
nav=$(cdp nav "file:///home/browser/chromium/Default/Preferences" "file:///etc/passwd" \
  "file:///opt/greenhouse/welcome.html" "https://smoke-blocked.example/" "http://host.docker.internal:4401/")
echo "$nav" | grep -q "chromium/Default/Preferences net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "profile readable via file://: $nav"
echo "$nav" | grep -q "/etc/passwd net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "file:// not blocked: $nav"
echo "$nav" | grep -q "welcome.html loaded" || fail "welcome page blocked: $nav"
echo "$nav" | grep -q "smoke-blocked.example/ net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "runtime blocklist ignored: $nav"
echo "$nav" | grep -q "host.docker.internal:4401/ net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "greenhouse port not blocked: $nav"
pass "file:// and greenhouse origins blocked by policy; welcome page allowed"

# 5. timed-out command leaves nothing behind
lines_into SHELL_ARGV "${TSX[@]}" shell 2 '(sleep 300 &); sleep 300'
set +e
docker exec -u agent -w /home/agent -e HOME=/home/agent -e GH_EXEC_ID=smoke-exec "$NAME" "${SHELL_ARGV[@]}" >/dev/null 2>&1
code=$?
set -e
[ "$code" = 124 ] || [ "$code" = 137 ] || fail "timeout(1) did not fire (exit $code)"
docker exec -u agent "$NAME" sh -c "$("${TSX[@]}" kill-script)" gh-kill smoke-exec "" >/dev/null
left=$(as_agent "pgrep -u agent -a sleep || true")
[ -z "$left" ] || fail "processes survived the timeout: $left"
pass "timed-out command (exit $code) leaves no process behind"

# 6. relay hand-off
cdp attach-and-vanish >/dev/null
handoff=$(timeout 15 docker exec -i -u browser "$NAME" python3 - drive-new-target <<<"$CDP_PY" || true)
[[ "$handoff" == pages=[1-9]*\ loaded=True* ]] || fail "the next DevTools client was not handed the browser cleanly (${handoff:-timeout})"
pass "relay hand-off: the next client is shown the open pages and loads a new tab (${handoff})"

# 7. desktop, WebGL, language
for proc in openbox tint2; do
  docker exec "$NAME" pgrep -u browser -x "$proc" >/dev/null || fail "$proc is not running"
done
docker exec "$NAME" pgrep -u browser -f '/usr/local/bin/gh-window watch' >/dev/null || fail "the window watchdog is not running"
as_browser xdotool search --onlyvisible --class tint2 >/dev/null || fail "the tint2 panel is not on screen"
screen_h=$(docker exec "$NAME" sh -c 'echo "${GH_COMPUTER_GEOMETRY:-1280x800}"' | cut -dx -f2)
browser_wid=$(as_browser xdotool search --onlyvisible --class chromium | sed -n 1p)
browser_h=$(as_browser xdotool getwindowgeometry "$browser_wid" | sed -n 's/.*Geometry: [0-9]*x\([0-9]*\).*/\1/p')
[ -n "$browser_h" ] && [ "$browser_h" -le $((screen_h - 24)) ] ||
  fail "the maximized browser (height ${browser_h:-?}) covers the panel (screen height ${screen_h})"
pass "openbox, tint2 and the window watchdog run; the maximized browser leaves the panel free (${browser_h}/${screen_h} px)"
renderer=$(cdp webgl)
[ -n "$renderer" ] && [ "$renderer" != none ] || fail "no WebGL in the browser"
pass "WebGL in the real browser: ${renderer}"
languages=$(cdp languages)
[ "$languages" = "zh-CN,zh,en" ] || fail "navigator.languages is ${languages}, expected zh-CN,zh,en (the default)"
env_lang=$(docker exec "$NAME" sh -c 'tr "\0" "\n" </proc/$(pgrep -o -x chromium)/environ | sed -n "s/^LANGUAGE=//p"')
[ "$env_lang" = zh_CN ] || fail "Chromium runs with LANGUAGE=${env_lang:-unset}, expected zh_CN"
pass "language: navigator.languages=${languages}, LANGUAGE=${env_lang} (default zh-CN)"

# 8. gh-window: minimised → restored by the watchdog / by restore; new window
browser_hex=$(printf '0x%x' "$browser_wid")
window_state() { as_browser gh-window list | awk -v id="$1" '$1 == id { print $2 }'; }
is_iconic() { [ "$(window_state "$browser_hex")" = iconic ]; }
is_normal() { [ "$(window_state "$browser_hex")" = normal ]; }
as_browser xdotool windowminimize "$browser_wid"
wait_until 3 is_iconic >/dev/null || fail "xdotool could not minimise the browser (state: $(window_state "$browser_hex"))"
took=$(wait_until 8 is_normal) || fail "the watchdog did not restore the minimised browser within 8 s"
pass "watchdog: a minimised browser came back by itself after ${took} s"
as_browser xdotool windowminimize "$browser_wid"
wait_until 3 is_iconic >/dev/null || fail "could not minimise the browser again"
as_browser gh-window restore || fail "gh-window restore failed"
is_normal || fail "gh-window restore returned but the browser is still minimised"
pass "gh-window restore brings a minimised browser back at once"
before=$(as_browser gh-window list | wc -l | tr -d ' ')
as_browser gh-window new || fail "gh-window new failed"
after=$(as_browser gh-window list | wc -l | tr -d ' ')
[ "$after" -gt "$before" ] || fail "gh-window new did not open a window (${before} → ${after})"
# Browser processes = chromium processes without --type= (renderers, GPU, … have one).
browsers=$(docker exec "$NAME" pgrep -u browser -a -x chromium | grep -vc -- ' --type=' || true)
[ "$browsers" = 1 ] || fail "${browsers} browser processes after gh-window new (a second browser was started)"
pass "gh-window new opened a window in the running browser (${before} → ${after} windows, one browser)"

# 9. the agent's tools and user-level installs
missing=$(as_agent_login 'for t in python3 pip pipx node npm ffmpeg pandoc sqlite3 gcc make tmux git; do command -v "$t" >/dev/null || printf "%s " "$t"; done')
[ -z "$missing" ] || fail "missing for the agent: ${missing}"
as_agent_login 'test -z "${PIP_USER:-}" && test "$PIP_BREAK_SYSTEM_PACKAGES" = 1 &&
  test "$NPM_CONFIG_PREFIX" = /home/agent/.npm-global && test "$PIPX_HOME" = /home/agent/.local/pipx &&
  case ":$PATH:" in *:/home/agent/.local/bin:*) ;; *) exit 1 ;; esac &&
  case ":$PATH:" in *:/home/agent/.npm-global/bin:*) ;; *) exit 1 ;; esac' ||
  fail "the agent's login shell lacks the install environment (/etc/profile.d/greenhouse-agent.sh)"
# A virtualenv in /tmp: /tmp must allow exec, and pip must work inside a venv.
as_agent_login 'python3 -m venv /tmp/gh-smoke-venv && /tmp/gh-smoke-venv/bin/pip --version >/dev/null' ||
  fail "pip inside a virtualenv in /tmp does not run (noexec /tmp, or PIP_USER set)"
pass "a virtualenv in /tmp runs its own pip"
# A wheel and an npm tarball built in the container: installs that need no network.
docker exec -i -u agent -e HOME=/home/agent "$NAME" python3 - <<'PY'
import base64, hashlib, zipfile
files = {
    'ghsmoke/__init__.py': b'def main():\n    print("pip-ok")\n',
    'ghsmoke-1.0.dist-info/METADATA': b'Metadata-Version: 2.1\nName: ghsmoke\nVersion: 1.0\n',
    'ghsmoke-1.0.dist-info/WHEEL': b'Wheel-Version: 1.0\nGenerator: smoke\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    'ghsmoke-1.0.dist-info/entry_points.txt': b'[console_scripts]\nghsmoke = ghsmoke:main\n',
}
record = ''.join(f'{p},sha256={base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b"=").decode()},{len(d)}\n' for p, d in files.items())
with zipfile.ZipFile('/tmp/ghsmoke-1.0-py3-none-any.whl', 'w') as wheel:
    for path, data in files.items():
        wheel.writestr(path, data)
    wheel.writestr('ghsmoke-1.0.dist-info/RECORD', record + 'ghsmoke-1.0.dist-info/RECORD,,\n')
PY
as_agent_login 'pip install --no-index --quiet /tmp/ghsmoke-1.0-py3-none-any.whl' || fail "pip install (user) failed"
[ "$(as_agent_login 'ghsmoke')" = pip-ok ] || fail "the pip-installed command does not run from PATH"
site=$(as_agent_login 'python3 -c "import ghsmoke; print(ghsmoke.__file__)"')
case "$site" in /home/agent/.local/lib/python3*/site-packages/ghsmoke/__init__.py) ;; *) fail "pip installed outside ~/.local: $site" ;; esac
as_agent_login 'set -e; d=$(mktemp -d); cd "$d"
  printf "%s" "{\"name\":\"ghsmoke-npm\",\"version\":\"1.0.0\",\"bin\":{\"ghsmoke-npm\":\"cli.js\"}}" >package.json
  printf "#!/usr/bin/env node\nconsole.log(\"npm-ok\")\n" >cli.js
  npm pack --silent >/dev/null
  npm install --global --offline --no-audit --no-fund --silent "$d/ghsmoke-npm-1.0.0.tgz" >/dev/null' ||
  fail "npm install -g failed"
[ "$(as_agent_login 'ghsmoke-npm')" = npm-ok ] || fail "the npm -g command does not run from PATH"
[ "$(as_agent_login 'command -v ghsmoke-npm')" = /home/agent/.npm-global/bin/ghsmoke-npm ] || fail "npm -g installed outside ~/.npm-global"
pass "agent tools present (pip pipx node npm ffmpeg pandoc sqlite3 gcc tmux …); pip → ~/.local, npm -g → ~/.npm-global"

# 10. gh-jobs
quick=$(jobs_cli start --name quick -- 'echo hello-$((40+2)); echo to-stderr >&2; exit 3')
quick_id=$(echo "$quick" | json .id)
[[ "$quick_id" =~ ^j[0-9a-f]{8}$ ]] || fail "gh-jobs start gave no job id: $quick"
[ "$(echo "$quick" | json '.pid | type')" = number ] || fail "gh-jobs start gave no pid: $quick"
job_status() { jobs_cli list | json ".[] | select(.id == \"$1\") | .status"; }
job_exited() { [ "$(job_status "$1")" = exited ]; }
wait_until 10 job_exited "$quick_id" >/dev/null || fail "the quick job never finished ($(job_status "$quick_id"))"
[ "$(jobs_cli list | json ".[] | select(.id == \"$quick_id\") | \"\(.exit_code) \(.ended_at != null) \(.log_bytes > 0)\"")" = "3 true true" ] ||
  fail "the quick job's record is wrong: $(jobs_cli list)"
log=$(jobs_cli log "$quick_id")
[[ "$log" == *hello-42* && "$log" == *to-stderr* ]] || fail "gh-jobs log lacks stdout or stderr: $log"
[ "$(jobs_cli log "$quick_id" --lines 1)" = to-stderr ] || fail "gh-jobs log --lines 1 is not the last line"
long=$(jobs_cli start --name long --cwd /home/agent -- sleep 300)
long_id=$(echo "$long" | json .id)
[ "$(jobs_cli running)" = 1 ] || fail "gh-jobs running is not 1"
long_sid=$(jobs_cli sids)
as_agent "pgrep -s $long_sid -x sleep" >/dev/null || fail "gh-jobs sids does not name the job's session ($long_sid)"
[ "$(jobs_cli list | json '.[0].id')" = "$long_id" ] || fail "gh-jobs list is not newest first"
[ "$(jobs_cli list | json ".[0] | \"\(.name)|\(.command)|\(.cwd)|\(.status)\"")" = "long|sleep 300|/home/agent|running" ] ||
  fail "the running job's record is wrong: $(jobs_cli list | json '.[0]')"
stopped=$(jobs_cli stop "$long_id")
[ "$(echo "$stopped" | json .stopped)" = true ] || fail "gh-jobs stop: $stopped"
[ "$(jobs_cli list | json ".[] | select(.id == \"$long_id\") | \"\(.status) \(.exit_code)\"")" = "exited 143" ] ||
  fail "a stopped job does not read exited 143: $(jobs_cli list)"
[ "$(jobs_cli running)" = 0 ] || fail "gh-jobs running is not 0 after stop"
[ "$(jobs_cli stop "$long_id" | json .stopped)" = false ] || fail "stopping a finished job claims it stopped"
codes=""
for argv in "log j00000000" "stop j00000000" "log ../x" "bogus" "start --name x" "log $quick_id --lines x"; do
  set +e
  # shellcheck disable=SC2086 # word splitting is the point
  jobs_cli $argv >/dev/null 2>&1
  codes="$codes$? "
  set -e
done
[ "$codes" = "3 3 3 2 2 2 " ] || fail "gh-jobs exit codes (unknown id ×3, usage ×3) are ${codes}"
# A job started from a Bot shell call outlives that call's cleanup (GH_EXEC_ID kill).
tagged=$(docker exec -u agent -e HOME=/home/agent -e GH_EXEC_ID=smoke-job "$NAME" gh-jobs start --name tagged -- sleep 300 | json .id)
docker exec -u agent "$NAME" sh -c "$("${TSX[@]}" kill-script)" gh-kill smoke-job "" >/dev/null
sleep 0.5
[ "$(job_status "$tagged")" = running ] || fail "a job died with the shell call that started it"
jobs_cli stop "$tagged" >/dev/null
pass "gh-jobs: start/list/log/running/sids/stop, exit codes 3/2, newest first; a job outlives its shell call"

# 11. gh-term
roundtrip=$(terminal roundtrip) || fail "gh-term round trip failed"
[[ "$roundtrip" == "size=123x"* && "$roundtrip" == *"resized=100x"* && "$roundtrip" == *"exit=0" ]] ||
  fail "gh-term round trip: $roundtrip"
reattach=$(terminal reattach) || fail "gh-term reattach failed"
[[ "$reattach" == "same-shell=yes exit=0" ]] || fail "gh-term reattach: $reattach"
pass "gh-term: framed resize + echo round trip (${roundtrip}); a reconnect lands in the same shell"

# 12. gh-agent-kill
job=$(jobs_cli start --name survivor -- sleep 3002 | json .id)
docker exec -d -u agent "$NAME" sleep 3003
as_agent 'setsid -f sleep 3004 </dev/null >/dev/null 2>&1; nohup sleep 3005 </dev/null >/dev/null 2>&1 &'
sleep 0.5
kill_run=$(terminal kill) || fail "the terminal did not survive gh-agent-kill"
killed=$(echo "$kill_run" | sed -n 's/.*killed=\([0-9]*\).*/\1/p')
[ "${killed:-0}" -ge 3 ] || fail "gh-agent-kill killed ${killed:-?} processes, expected the 3 strays: $kill_run"
for n in 3003 3004 3005; do
  if as_agent "pgrep -u agent -f 'sleep $n'" >/dev/null; then fail "stray 'sleep $n' survived gh-agent-kill"; fi
done
as_agent "pgrep -u agent -f 'sleep 3001'" >/dev/null || fail "gh-agent-kill killed a process running in the member's terminal"
as_agent "pgrep -u agent -f 'sleep 3002'" >/dev/null || fail "gh-agent-kill killed a background job"
[ "$(job_status "$job")" = running ] || fail "the job does not read running after gh-agent-kill"
# The server renames itself (its process name, not its argv).
as_agent "pgrep -u agent -x 'tmux: server'" >/dev/null || fail "gh-agent-kill killed the tmux server"
pass "gh-agent-kill: ${killed} strays killed; the job, tmux and the open terminal (and its 'sleep 3001') survived"

# 13. persistence across stop + rm + run (and a language change)
as_agent "mkdir -p ~/work && echo kept > ~/work/smoke.txt"
cdp setcookie >/dev/null
t0=$SECONDS
docker stop -t 5 "$NAME" >/dev/null
stop_s=$((SECONDS - t0))
docker logs "$NAME" 2>&1 | grep -q 'chromium exited (0)' || fail "browser did not shut down cleanly on docker stop"
docker rm "$NAME" >/dev/null
start_computer -e GH_COMPUTER_LANG=en-US
[ "$(as_agent 'cat ~/work/smoke.txt')" = "kept" ] || fail "files lost across rm + run"
cdp getcookie | grep -qw gh_smoke || fail "browser cookies lost across rm + run"
[ "$(as_agent_login 'ghsmoke')" = pip-ok ] || fail "the pip install did not survive rm + run"
[ "$(as_agent_login 'ghsmoke-npm')" = npm-ok ] || fail "the npm -g install did not survive rm + run"
[ "$(job_status "$job")" = lost ] || fail "a job cut off by the restart reads $(job_status "$job"), expected lost"
pass "home survives stop (${stop_s} s, clean browser exit) + rm + run: files, cookies, pip/npm installs intact; the cut-off job reads lost"
languages=$(cdp languages)
[ "$languages" = "en-US,en" ] || fail "after GH_COMPUTER_LANG=en-US, navigator.languages is ${languages}"
pass "the same profile follows GH_COMPUTER_LANG=en-US: navigator.languages=${languages}"

# 14. egress lockdown (curl 7 = refused, 28 = timed out: no connection made)
if [ "$OWN_NETWORK" = 1 ]; then
  echo "  - egress lockdown not checked (set BOTS_COMPUTER_NETWORK to the hardened bridge)"
else
  gateway=$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')
  for url in "http://${gateway}:${API_PORT:-3000}/" "http://169.254.169.254/"; do
    set +e
    as_agent "curl -sS -m 3 --noproxy '*' -o /dev/null '$url'" >/dev/null 2>&1
    code=$?
    set -e
    [ "$code" = 7 ] || [ "$code" = 28 ] || fail "the computer reached ${url} (curl exit ${code}): egress rules not in force"
  done
  pass "egress lockdown: ${gateway}:${API_PORT:-3000} and cloud metadata refused"
fi

echo "==> all checks passed"
