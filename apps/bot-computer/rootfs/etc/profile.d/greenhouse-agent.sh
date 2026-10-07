# Login shells of uid `agent` — the Bot's shell (`bash -lc`), the member's
# terminal (tmux panes) and background jobs (gh-jobs) — install software into
# the home volume: the root filesystem is read-only and there is no root, but
# /home/agent survives every restart, so `pip install x`, `npm i -g x` and
# `pipx install x` are installed once and stay.
# shellcheck shell=sh
if [ "$(id -un)" = agent ]; then
  # A `docker exec -u agent` without -e HOME inherits the image's
  # HOME=/home/browser, which this uid cannot write; installs would fail there.
  if [ "$HOME" != /home/agent ]; then
    HOME=/home/agent
    export HOME
  fi
  PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  # npm -g → ~/.npm-global/{lib/node_modules,bin}
  NPM_CONFIG_PREFIX="$HOME/.npm-global"
  # pip → ~/.local (user site): with the system site-packages read-only, pip
  # falls back to a user install by itself. Debian marks the system Python as
  # externally managed (PEP 668); with nothing writable outside the home, a
  # user install cannot break the system, so pip may proceed. No PIP_USER: it
  # would break pip inside every virtualenv ("user site-packages are not
  # visible in this virtualenv").
  PIP_BREAK_SYSTEM_PACKAGES=1
  PIPX_HOME="$HOME/.local/pipx"
  PIPX_BIN_DIR="$HOME/.local/bin"
  export PATH NPM_CONFIG_PREFIX PIP_BREAK_SYSTEM_PACKAGES PIPX_HOME PIPX_BIN_DIR
fi
