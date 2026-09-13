#!/usr/bin/env bash
# Build the greenhouse/agent-runtime image (Mission Sandbox Runner).
#
# Prereqs on the host: docker; one-time network setup for the controller:
#   docker network create --opt com.docker.network.bridge.enable_icc=false cloud-agent
# Egress hardening (DOCKER-USER + INPUT rules for RFC1918/link-local/metadata)
# is a separate ops step — scripts/cloud-agent-net.sh, apply before enabling on
# a shared server. See docs/specs/20260731-cloud-agent-runtime.md.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${SANDBOX_RUNNER_IMAGE:-${CLOUD_AGENT_IMAGE:-greenhouse/agent-runtime:latest}}"
# CN-network默认走 TUNA；服务器上可 DEBIAN_MIRROR=mirrors.tencentyun.com（CVM 内网源）
MIRROR="${DEBIAN_MIRROR:-mirrors.tuna.tsinghua.edu.cn}"
# 镜像中保留的公共 apt 元数据仅供非 hardened 本地诊断；Mission 的根文件系统
# 只读，Agent 不能运行时安装系统包。CVM 内网源是 link-local，故也不能烤进去。
RUNTIME_MIRROR="${RUNTIME_DEBIAN_MIRROR:-mirrors.tuna.tsinghua.edu.cn}"
NPM_REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"
# pip 同一套「构建源 / 诊断元数据」分离逻辑；Mission 仅允许装到 workspace-local target。
PIP_INDEX="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
RUNTIME_PIP_INDEX="${RUNTIME_PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

# 镜像源全是国内主机，绝不该走代理：开发机 ~/.docker/config.json 里常年配着
# Clash（http://127.0.0.1:7890），而 apt 一次要拉 250 个包 / 320 MB，代理在这种
# 并发下会零星回 502，把整层构建打掉——2026-08-01 连挂两次就是这么来的，而且实测
# 直连 TUNA 比走代理快一倍。服务器上没有代理，设了也是空操作。
host_of() { echo "$1" | sed -e 's|^[a-z]*://||' -e 's|/.*$||'; }
NO_PROXY_HOSTS="$(host_of "${MIRROR}"),$(host_of "${RUNTIME_MIRROR}"),$(host_of "${NPM_REG}"),$(host_of "${PIP_INDEX}"),$(host_of "${RUNTIME_PIP_INDEX}"),deb.debian.org,security.debian.org"

echo "==> compiling Mission Sandbox Runner (apps/agent-runner)"
pnpm --filter @greenhouse/sandbox-runner build

echo "==> building image ${TAG} (build apt: ${MIRROR}, shipped apt: ${RUNTIME_MIRROR}, npm: ${NPM_REG}, pip: ${PIP_INDEX})"
echo "==> bypassing any docker/http proxy for: ${NO_PROXY_HOSTS}"
# --network=host: buildkit's sandboxed build network has no DNS on some hosts
# (OrbStack + proxy setups) while runtime containers resolve fine.
docker build --network=host -f apps/agent-runner/Dockerfile \
  --build-arg no_proxy="${NO_PROXY_HOSTS}" \
  --build-arg NO_PROXY="${NO_PROXY_HOSTS}" \
  --build-arg DEBIAN_MIRROR="${MIRROR}" \
  --build-arg RUNTIME_DEBIAN_MIRROR="${RUNTIME_MIRROR}" \
  --build-arg NPM_REGISTRY="${NPM_REG}" \
  --build-arg PIP_INDEX_URL="${PIP_INDEX}" \
  --build-arg RUNTIME_PIP_INDEX_URL="${RUNTIME_PIP_INDEX}" \
  -t "${TAG}" .

echo "==> done: ${TAG}"
docker image inspect "${TAG}" --format 'size: {{.Size}} bytes'
