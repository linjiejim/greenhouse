#!/usr/bin/env bash
# Mission Sandbox Runner per-user project quota provisioner + live attester.
#
# The API only invokes `attest` (read-only). `ensure` and `bootstrap` are ops
# commands and require root. Keeping provisioning out of the web process means
# a new `<dataRoot>/homes/<userId>` never silently becomes usable as project 0:
# until ops assigns and verifies a non-zero project, that user's Mission POST
# fails closed while historical reads keep working.
#
# Supported filesystems: XFS project quota and ext4 project quota. The mount
# must already be mounted with pquota/prjquota; this script never edits fstab or
# remounts a filesystem.
set -euo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH LANG=C LC_ALL=C

FINDMNT_BIN="${FINDMNT_BIN:-findmnt}"
REALPATH_BIN="${REALPATH_BIN:-realpath}"
XFS_IO_BIN="${XFS_IO_BIN:-xfs_io}"
XFS_QUOTA_BIN="${XFS_QUOTA_BIN:-xfs_quota}"
LSATTR_BIN="${LSATTR_BIN:-lsattr}"
CHATTR_BIN="${CHATTR_BIN:-chattr}"
SETQUOTA_BIN="${SETQUOTA_BIN:-setquota}"
REPQUOTA_BIN="${REPQUOTA_BIN:-repquota}"
FLOCK_BIN="${FLOCK_BIN:-flock}"
SHA256SUM_BIN="${SHA256SUM_BIN:-sha256sum}"

STATE_FILE="${SANDBOX_RUNNER_QUOTA_STATE_FILE:-/var/lib/greenhouse/sandbox-runner-quota/projects.tsv}"
PROJECTS_FILE="${SANDBOX_RUNNER_PROJECTS_FILE:-/etc/projects}"
PROJID_FILE="${SANDBOX_RUNNER_PROJID_FILE:-/etc/projid}"
PROJECT_ID_FLOOR=100000

usage() {
  cat <<'EOF'
Usage:
  sandbox-runner-quota.sh attest \
    --data-root PATH --user-id ID --path PATH --limit-bytes N \
    --inode-limit N --mechanism xfs-project|ext4-project

  sudo sandbox-runner-quota.sh ensure \
    --data-root PATH --user-id ID --path PATH --limit-bytes N \
    --inode-limit N --mechanism xfs-project|ext4-project

  sudo sandbox-runner-quota.sh bootstrap \
    --data-root PATH --limit-bytes N --inode-limit N \
    --mechanism xfs-project|ext4-project --marker PATH \
    --attest-command /usr/local/sbin/greenhouse-sandbox-runner-quota

`attest` is read-only and prints exactly one JSON object. `ensure` assigns a
non-zero, exclusive project id, applies byte+inode hard limits, then runs the
same live checks. `bootstrap` provisions all existing user homes and writes the
root-owned v2 marker consumed by the API preflight.
EOF
}

die() {
  echo "sandbox-runner-quota: $*" >&2
  exit 1
}

require_root() {
  [ "${EUID}" -eq 0 ] || die "this operation must run as root"
}

require_uint() {
  local value="$1" label="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "$label must be a positive integer"
  [ "$value" -le 9007199254740991 ] || die "$label exceeds the safe integer range"
}

require_safe_path() {
  local value="$1" label="$2"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$label must be an absolute path using safe characters"
  [ "$value" != / ] || die "$label may not be the filesystem root"
  [ "$value" = "${value%/}" ] || die "$label may not end with a slash"
  case "$value" in *//* ) die "$label may not contain an empty path segment" ;; esac
  case "/$value/" in */../* ) die "$label may not contain a parent path segment" ;; esac
  case "/$value/" in */./* ) die "$label may not contain a current-directory path segment" ;; esac
}

canonical_maybe_missing() {
  if [ -e "$1" ]; then
    "$REALPATH_BIN" "$1"
  else
    # Safe-path validation above excludes `.`/`..`/duplicate separators. The
    # deploy-time bootstrap may legitimately target a not-yet-created root,
    # so GNU-only `realpath -m` is intentionally avoided (macOS test/ops hosts
    # do not support it).
    printf '%s\n' "$1"
  fi
}

mode="${1:-}"
case "$mode" in
  attest | ensure | bootstrap) shift ;;
  -h | --help | help | '') usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

data_root=''
user_id=''
user_path=''
limit_bytes=''
inode_limit=''
mechanism=''
marker_path=''
attest_command=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-root) data_root="${2:-}"; shift 2 ;;
    --user-id) user_id="${2:-}"; shift 2 ;;
    --path) user_path="${2:-}"; shift 2 ;;
    --limit-bytes) limit_bytes="${2:-}"; shift 2 ;;
    --inode-limit) inode_limit="${2:-}"; shift 2 ;;
    --mechanism) mechanism="${2:-}"; shift 2 ;;
    --marker) marker_path="${2:-}"; shift 2 ;;
    --attest-command) attest_command="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_safe_path "$data_root" data-root
require_uint "$limit_bytes" limit-bytes
require_uint "$inode_limit" inode-limit
[ $((limit_bytes % 1024)) -eq 0 ] || die "limit-bytes must be divisible by 1024"
case "$mechanism" in
  xfs-project | ext4-project) ;;
  *) die "mechanism must be xfs-project or ext4-project" ;;
esac

data_root="$(canonical_maybe_missing "$data_root")"
homes_root="${data_root}/homes"
limit_kib=$((limit_bytes / 1024))

mount_target() {
  "$FINDMNT_BIN" -T "$data_root" -n -o TARGET | head -n 1
}

assert_quota_mount() {
  local actual_fs options expected_fs
  actual_fs="$("$FINDMNT_BIN" -T "$data_root" -n -o FSTYPE | head -n 1)"
  options="$("$FINDMNT_BIN" -T "$data_root" -n -o OPTIONS | head -n 1)"
  expected_fs=ext4
  [ "$mechanism" = xfs-project ] && expected_fs=xfs
  [ "$actual_fs" = "$expected_fs" ] || die "data root is not on expected $expected_fs filesystem"
  [[ ",$options," =~ ,(pquota|prjquota), ]] || die "project quota is not enabled on the data root mount"
}

xfs_project_state() {
  local path="$1" output project_id inherits xflags
  output="$("$XFS_IO_BIN" -c stat -- "$path")"
  project_id="$(printf '%s\n' "$output" | awk -F'= ' '/fsxattr\.projid/ {gsub(/[[:space:]]/, "", $2); print $2; exit}')"
  inherits=false
  # xfsprogs prints the inherit bit as a verbose name on some versions and as
  # a positional letter code ("[--------P--------]") on others (6.6.0). The
  # hex bitmask is the stable interface: XFS_XFLAG_PROJINHERIT = 0x200.
  xflags="$(printf '%s\n' "$output" | awk '/fsxattr\.xflags/ {print $3; exit}')"
  if [[ "$xflags" =~ ^0x[0-9a-fA-F]+$ ]] && [ $((xflags & 0x200)) -ne 0 ]; then
    inherits=true
  elif printf '%s\n' "$output" | grep -F 'proj-inherit' >/dev/null; then
    inherits=true
  fi
  printf '%s\t%s\n' "$project_id" "$inherits"
}

ext4_project_state() {
  local path="$1" output attrs project_id inherits
  output="$("$LSATTR_BIN" -p -d -- "$path")"
  # e2fsprogs releases have printed `-p` as either
  # `<project> <attrs> <path>` or `<attrs> <project> <path>`. Identify fields
  # by shape instead of baking in one distro's column order.
  attrs="$(printf '%s\n' "$output" | awk 'NR == 1 {for (i=1; i<=NF; i++) if ($i ~ /^[-A-Za-z]+$/) {print $i; exit}}')"
  project_id="$(printf '%s\n' "$output" | awk 'NR == 1 {for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+$/) {print $i; exit}}')"
  inherits=false
  [[ "$attrs" == *P* ]] && inherits=true
  printf '%s\t%s\n' "$project_id" "$inherits"
}

project_state() {
  if [ "$mechanism" = xfs-project ]; then
    xfs_project_state "$1"
  else
    ext4_project_state "$1"
  fi
}

normalize_project_id() {
  local value="$1"
  value="${value#\#}"
  [[ "$value" =~ ^[0-9]+$ ]] || die "kernel did not report a numeric project id"
  printf '%s\n' "$value"
}

xfs_hard_limits() {
  local mount="$1" project_id="$2" block_line inode_line hard_kib hard_inodes
  block_line="$("$XFS_QUOTA_BIN" -x -c 'report -p -b -n -N' "$mount" | awk -v wanted="$project_id" '
    { id=$1; sub(/^#/, "", id); if (id == wanted) { print; exit } }
  ')"
  inode_line="$("$XFS_QUOTA_BIN" -x -c 'report -p -i -n -N' "$mount" | awk -v wanted="$project_id" '
    { id=$1; sub(/^#/, "", id); if (id == wanted) { print; exit } }
  ')"
  [ -n "$block_line" ] && [ -n "$inode_line" ] || die "project quota report has no row for project $project_id"
  hard_kib="$(printf '%s\n' "$block_line" | awk '{print $4}')"
  hard_inodes="$(printf '%s\n' "$inode_line" | awk '{print $4}')"
  printf '%s\t%s\n' "$hard_kib" "$hard_inodes"
}

ext4_hard_limits() {
  local mount="$1" project_id="$2" limits
  limits="$("$REPQUOTA_BIN" -P -n -O csv "$mount" | awk -F, -v wanted="$project_id" '
    {
      for (i=1; i<=NF; i++) { gsub(/^"|"$/, "", $i) }
      id=$1; sub(/^#/, "", id)
      if (id == wanted) { print $4 "\t" $8; exit }
    }
  ')"
  [ -n "$limits" ] || die "project quota report has no row for project $project_id"
  printf '%s\n' "$limits"
}

hard_limits() {
  if [ "$mechanism" = xfs-project ]; then
    xfs_hard_limits "$1" "$2"
  else
    ext4_hard_limits "$1" "$2"
  fi
}

assert_project_exclusive() {
  local wanted_id="$1" wanted_path="$2" sibling state sibling_id
  [ -d "$homes_root" ] || die "homes root does not exist"
  while IFS= read -r -d '' sibling; do
    [ "$sibling" = "$wanted_path" ] && continue
    [ ! -L "$sibling" ] || die "sibling user home is a symbolic link: $sibling"
    state="$(project_state "$sibling")" || die "cannot inspect sibling project assignment: $sibling"
    sibling_id="$(normalize_project_id "${state%%$'\t'*}")"
    [ "$sibling_id" != "$wanted_id" ] || die "project $wanted_id is shared with another user home"
  done < <(find "$homes_root" -mindepth 1 -maxdepth 1 -type d -print0)
}

attest_user() {
  local expected_path mount state project_id inherits limits actual_kib actual_inodes actual_bytes verified_at
  [[ "$user_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "user-id contains unsafe characters"
  require_safe_path "$user_path" path
  expected_path="${homes_root}/${user_id}"
  [ "$(canonical_maybe_missing "$user_path")" = "$expected_path" ] || die "path is not the exact per-user home"
  [ -d "$expected_path" ] && [ ! -L "$expected_path" ] || die "per-user home is missing or not a real directory"
  [ "$("$REALPATH_BIN" "$expected_path")" = "$expected_path" ] || die "per-user home resolves outside its declared path"

  assert_quota_mount
  mount="$(mount_target)"
  [ -n "$mount" ] || die "cannot resolve the data root mount"
  state="$(project_state "$expected_path")"
  project_id="$(normalize_project_id "${state%%$'\t'*}")"
  inherits="${state#*$'\t'}"
  [ "$project_id" -gt 0 ] || die "per-user home is assigned to project 0"
  [ "$inherits" = true ] || die "per-user home does not inherit its project id"
  assert_project_exclusive "$project_id" "$expected_path"

  limits="$(hard_limits "$mount" "$project_id")"
  actual_kib="${limits%%$'\t'*}"
  actual_inodes="${limits#*$'\t'}"
  [[ "$actual_kib" =~ ^[0-9]+$ ]] || die "kernel byte hard limit is not numeric"
  [[ "$actual_inodes" =~ ^[0-9]+$ ]] || die "kernel inode hard limit is not numeric"
  actual_bytes=$((actual_kib * 1024))
  [ "$actual_bytes" -eq "$limit_bytes" ] || die "kernel byte hard limit does not match configuration"
  [ "$actual_inodes" -eq "$inode_limit" ] || die "kernel inode hard limit does not match configuration"

  verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '{"version":1,"data_root":"%s","user_id":"%s","path":"%s","scope":"per-user","mechanism":"%s","project_id":%s,"limit_bytes":%s,"inode_limit":%s,"project_inherit":true,"exclusive":true,"verified_at":"%s"}\n' \
    "$data_root" "$user_id" "$expected_path" "$mechanism" "$project_id" "$limit_bytes" "$inode_limit" "$verified_at"
}

atomic_project_entry() {
  local file="$1" key="$2" value="$3" tmp
  mkdir -p "$(dirname "$file")"
  touch "$file"
  [ ! -L "$file" ] || die "project registry may not be a symbolic link: $file"
  tmp="${file}.tmp.$$"
  awk -F: -v key="$key" -v value="$value" '$1 != key && $2 != value {print}' "$file" > "$tmp"
  printf '%s:%s\n' "$key" "$value" >> "$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}

allocate_project() {
  local found next_id project_name used
  mkdir -p "$(dirname "$STATE_FILE")"
  touch "$STATE_FILE"
  [ ! -L "$STATE_FILE" ] || die "quota state file may not be a symbolic link"
  chown root:root "$STATE_FILE"
  chmod 0600 "$STATE_FILE"

  found="$(awk -F $'\t' -v user="$user_id" '$1 == user {print $2 "\t" $3; exit}' "$STATE_FILE")"
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return
  fi

  next_id="$(awk -F $'\t' -v floor="$PROJECT_ID_FLOOR" 'BEGIN {max=floor-1} $2 ~ /^[0-9]+$/ && $2 > max {max=$2} END {print max+1}' "$STATE_FILE")"
  while :; do
    used=false
    while IFS= read -r -d '' sibling; do
      local sibling_state sibling_id
      sibling_state="$(project_state "$sibling" 2>/dev/null || true)"
      [ -n "$sibling_state" ] || continue
      sibling_id="$(normalize_project_id "${sibling_state%%$'\t'*}")"
      [ "$sibling_id" != "$next_id" ] || { used=true; break; }
    done < <(find "$homes_root" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null || true)
    [ "$used" = false ] && break
    next_id=$((next_id + 1))
  done
  project_name="greenhouse_$(printf '%s' "$user_id" | "$SHA256SUM_BIN" | awk '{print substr($1,1,20)}')"
  printf '%s\t%s\t%s\n' "$user_id" "$next_id" "$project_name" >> "$STATE_FILE"
  printf '%s\t%s\n' "$next_id" "$project_name"
}

ensure_user() {
  local lock_file allocation project_id project_name mount
  require_root
  [[ "$user_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "user-id contains unsafe characters"
  require_safe_path "$user_path" path
  [ "$(canonical_maybe_missing "$user_path")" = "${homes_root}/${user_id}" ] || die "path is not the exact per-user home"
  assert_quota_mount

  mkdir -p "$homes_root"
  chmod 0750 "$homes_root"
  lock_file="${STATE_FILE}.lock"
  mkdir -p "$(dirname "$lock_file")"
  exec 9>"$lock_file"
  "$FLOCK_BIN" -x 9

  mkdir -p "$user_path"
  chmod 0700 "$user_path"
  allocation="$(allocate_project)"
  project_id="${allocation%%$'\t'*}"
  project_name="${allocation#*$'\t'}"
  require_uint "$project_id" project-id
  [ "$project_id" -gt 0 ] || die "project-id may not be zero"
  atomic_project_entry "$PROJECTS_FILE" "$project_id" "$user_path"
  atomic_project_entry "$PROJID_FILE" "$project_name" "$project_id"
  mount="$(mount_target)"

  if [ "$mechanism" = xfs-project ]; then
    "$XFS_QUOTA_BIN" -x -c "project -s $project_name" "$mount" >/dev/null
    "$XFS_QUOTA_BIN" -x -c "limit -p bsoft=0 bhard=${limit_kib}k isoft=0 ihard=$inode_limit $project_name" "$mount" >/dev/null
  else
    "$CHATTR_BIN" -R -p "$project_id" -- "$user_path"
    "$CHATTR_BIN" +P -- "$user_path"
    "$SETQUOTA_BIN" -P "$project_name" 0 "$limit_kib" 0 "$inode_limit" "$mount"
  fi

  attest_user
}

bootstrap() {
  local script_path tmp user_home existing_user
  require_root
  require_safe_path "$marker_path" marker
  require_safe_path "$attest_command" attest-command
  [ -f "$attest_command" ] && [ ! -L "$attest_command" ] && [ -x "$attest_command" ] \
    || die "installed attest command must be a real executable file"
  [ "$(stat -c '%u' "$attest_command")" = 0 ] || die "installed attest command must be owned by root"
  [ $((8#$(stat -c '%a' "$attest_command") & 8#22)) -eq 0 ] || die "installed attest command must not be group/world writable"
  assert_quota_mount
  mkdir -p "$homes_root"
  chmod 0750 "$homes_root"

  script_path="$("$REALPATH_BIN" "$0")"
  while IFS= read -r -d '' user_home; do
    existing_user="$(basename "$user_home")"
    [[ "$existing_user" =~ ^[A-Za-z0-9_-]+$ ]] || die "unsafe user home found: $user_home"
    "$script_path" ensure \
      --data-root "$data_root" \
      --user-id "$existing_user" \
      --path "$user_home" \
      --limit-bytes "$limit_bytes" \
      --inode-limit "$inode_limit" \
      --mechanism "$mechanism" >/dev/null
  done < <(find "$homes_root" -mindepth 1 -maxdepth 1 -type d -print0)

  mkdir -p "$(dirname "$marker_path")"
  tmp="${marker_path}.tmp.$$"
  printf '{"version":2,"data_root":"%s","limit_bytes":%s,"inode_limit":%s,"scope":"per-user","mechanism":"%s","attest_command":"%s","verified_at":"%s"}\n' \
    "$data_root" "$limit_bytes" "$inode_limit" "$mechanism" "$attest_command" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$tmp"
  chown root:root "$tmp"
  chmod 0444 "$tmp"
  mv -f "$tmp" "$marker_path"
  echo "provisioned existing Mission homes and wrote $marker_path"
}

case "$mode" in
  attest)
    [ -n "$user_id" ] && [ -n "$user_path" ] || die "attest requires --user-id and --path"
    attest_user
    ;;
  ensure)
    [ -n "$user_id" ] && [ -n "$user_path" ] || die "ensure requires --user-id and --path"
    ensure_user
    ;;
  bootstrap)
    [ -n "$marker_path" ] && [ -n "$attest_command" ] || die "bootstrap requires --marker and --attest-command"
    bootstrap
    ;;
esac
