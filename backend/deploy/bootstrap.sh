#!/usr/bin/env bash
# Raspberry Pi entry point: install base tools and uv, store the GitHub token,
# then fetch install-release.sh from the given tag and run it.
#
#   sudo bash bootstrap.sh v0.1.0
set -euo pipefail

# Keep identical to VERSION_PATTERN in build_release.py and install-release.sh.
VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$'
REPOSITORY="${MOON_OBSERVE_REPOSITORY:-whyixd/moon_observe}"
INSTALL_ROOT="${MOON_OBSERVE_INSTALL_ROOT:-/opt/moon-observe}"
CONFIG_ROOT="${MOON_OBSERVE_CONFIG_ROOT:-/etc/moon-observe}"
TOKEN_FILE="${MOON_OBSERVE_GITHUB_TOKEN_FILE:-$CONFIG_ROOT/github-token}"

die() { echo "bootstrap: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0 VERSION"
[[ $# -eq 1 ]] || die "usage: sudo bash $0 VERSION (e.g. v0.1.0)"
VERSION="$1"
[[ $VERSION =~ $VERSION_PATTERN ]] || die "invalid version: $VERSION"
command -v apt-get >/dev/null || die "apt-get is required"

echo "==> Installing OS packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates coreutils curl python3 tar util-linux

if [[ ! -x /usr/local/bin/uv ]]; then
  echo "==> Installing uv to /usr/local/bin"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

install -d -m 0755 -o root -g root "$INSTALL_ROOT"
if [[ ! -d $CONFIG_ROOT ]]; then
  install -d -m 0700 -o root -g root "$CONFIG_ROOT"
fi

if [[ ! -s $TOKEN_FILE ]]; then
  [[ -r /dev/tty ]] || die "no TTY to read the GitHub token; create $TOKEN_FILE (mode 0600) first"
  read -r -s -p "GitHub fine-grained token (Contents: Read on $REPOSITORY): " token </dev/tty
  echo
  [[ -n $token ]] || die "empty token"
  (umask 077 && printf '%s\n' "$token" >"$TOKEN_FILE")
  unset token
fi
chown root:root "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
(umask 077 && printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" >"$workdir/auth")

echo "==> Fetching install-release.sh at $VERSION"
curl -fsSL -H @"$workdir/auth" \
  -H 'Accept: application/vnd.github.raw+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -o "$workdir/install-release.sh" \
  "https://api.github.com/repos/$REPOSITORY/contents/backend/deploy/install-release.sh?ref=$VERSION"

MOON_OBSERVE_REPOSITORY="$REPOSITORY" \
MOON_OBSERVE_INSTALL_ROOT="$INSTALL_ROOT" \
MOON_OBSERVE_CONFIG_ROOT="$CONFIG_ROOT" \
MOON_OBSERVE_GITHUB_TOKEN_FILE="$TOKEN_FILE" \
  bash "$workdir/install-release.sh" "$VERSION"
