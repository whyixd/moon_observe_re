#!/usr/bin/env bash
# Download, verify, install and activate one release (backend + built frontend) on the Raspberry Pi.
# Normally started by bootstrap.sh. Re-running with an already installed version
# reactivates it without network access (this is also the rollback command).
#
#   sudo bash install-release.sh v0.1.0
set -euo pipefail

# Keep identical to VERSION_PATTERN in build_release.py and bootstrap.sh.
VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$'
APP=moon-observe-backend
SERVICE=moon-observe
REPOSITORY="${MOON_OBSERVE_REPOSITORY:-whyixd/moon_observe}"
INSTALL_ROOT="${MOON_OBSERVE_INSTALL_ROOT:-/opt/moon-observe}"
CONFIG_ROOT="${MOON_OBSERVE_CONFIG_ROOT:-/etc/moon-observe}"
TOKEN_FILE="${MOON_OBSERVE_GITHUB_TOKEN_FILE:-$CONFIG_ROOT/github-token}"
SERVICE_USER="${MOON_OBSERVE_SERVICE_USER:-moon-observe}"
KEEP_RELEASES="${MOON_OBSERVE_KEEP_RELEASES:-3}"
HEALTH_URL="${MOON_OBSERVE_HEALTH_URL:-http://127.0.0.1:8765/api/state}"
PAGE_URL="${MOON_OBSERVE_PAGE_URL:-http://127.0.0.1:8765/}"
HEALTH_TIMEOUT="${MOON_OBSERVE_HEALTH_TIMEOUT:-20}"
UV="${UV:-$(command -v uv || echo /usr/local/bin/uv)}"
COMPLETE_MARKER=.install-complete

die() { echo "install-release: $*" >&2; exit 1; }
log() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ $# -eq 1 ]] || die "usage: sudo bash $0 VERSION (e.g. v0.1.0)"
VERSION="$1"
[[ $VERSION =~ $VERSION_PATTERN ]] || die "invalid version: $VERSION"
for root in "$INSTALL_ROOT" "$CONFIG_ROOT"; do
  [[ $root == /* && $root != *[[:space:]\|\&\\]* ]] || die "install/config roots must be absolute paths without spaces or | & \\: $root"
done
[[ $KEEP_RELEASES =~ ^[1-9][0-9]*$ ]] || die "MOON_OBSERVE_KEEP_RELEASES must be a positive integer"
[[ $HEALTH_TIMEOUT =~ ^[1-9][0-9]*$ ]] || die "MOON_OBSERVE_HEALTH_TIMEOUT must be a positive integer"
for command in curl python3 sha256sum tar systemctl runuser useradd; do
  command -v "$command" >/dev/null || die "$command is required"
done

TOP="$APP-$VERSION"
ARCHIVE="$TOP.tar.gz"
RELEASES="$INSTALL_ROOT/releases"
RELEASE_DIR="$RELEASES/$VERSION"
CURRENT="$INSTALL_ROOT/current"
UNIT_PATH="/etc/systemd/system/$SERVICE.service"

workdir="$(mktemp -d)"
incomplete_release=""
cleanup() {
  local status=$?
  rm -rf "$workdir"
  if [[ -n $incomplete_release ]]; then
    echo "install-release: removing incomplete $incomplete_release" >&2
    rm -rf -- "$incomplete_release"
  fi
  exit "$status"
}
trap cleanup EXIT

previous=""
if [[ -L $CURRENT ]]; then
  previous="$(readlink -f "$CURRENT")"
fi
if [[ $previous == "$RELEASE_DIR" ]]; then
  log "$VERSION is already active; use 'systemctl restart $SERVICE' to restart it"
  exit 0
fi

fetch_release() {
  local token="${GITHUB_TOKEN:-}" ids archive_id sums_id expected actual
  if [[ -z $token ]]; then
    [[ -r $TOKEN_FILE ]] || die "no GITHUB_TOKEN and $TOKEN_FILE is not readable"
    token="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  fi
  [[ -n $token ]] || die "empty GitHub token"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$workdir/auth")
  unset token
  api() { curl -fsSL -H @"$workdir/auth" -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }

  log "Looking up release $VERSION in $REPOSITORY"
  api -H 'Accept: application/vnd.github+json' -o "$workdir/release.json" \
    "https://api.github.com/repos/$REPOSITORY/releases/tags/$VERSION"
  ids="$(python3 - "$workdir/release.json" "$ARCHIVE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    release = json.load(stream)
wanted = {sys.argv[2]: None, "SHA256SUMS": None}
for asset in release.get("assets", []):
    if asset.get("name") in wanted:
        wanted[asset["name"]] = asset["id"]
missing = [name for name, ident in wanted.items() if ident is None]
if missing:
    sys.exit("release is missing assets: " + ", ".join(missing))
print(wanted[sys.argv[2]], wanted["SHA256SUMS"])
PY
)"
  read -r archive_id sums_id <<<"$ids"

  log "Downloading $ARCHIVE"
  api -H 'Accept: application/octet-stream' -o "$workdir/$ARCHIVE" \
    "https://api.github.com/repos/$REPOSITORY/releases/assets/$archive_id"
  api -H 'Accept: application/octet-stream' -o "$workdir/SHA256SUMS" \
    "https://api.github.com/repos/$REPOSITORY/releases/assets/$sums_id"

  expected="$(awk -v name="$ARCHIVE" '$2 == name || $2 == "*" name { print $1; count++ } END { exit count != 1 }' \
    "$workdir/SHA256SUMS")" || die "SHA256SUMS must list $ARCHIVE exactly once"
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "malformed checksum for $ARCHIVE"
  actual="$(sha256sum "$workdir/$ARCHIVE" | cut -d' ' -f1)"
  [[ $actual == "$expected" ]] || die "SHA-256 mismatch for $ARCHIVE"
  log "SHA-256 verified"

  tar -tzf "$workdir/$ARCHIVE" >"$workdir/members"
  awk -v top="$TOP" '
    $0 != top && $0 != top "/" && index($0, top "/") != 1 { bad = 1 }
    /(^|\/)\.\.(\/|$)/ { bad = 1 }
    END { exit bad }' "$workdir/members" || die "archive has entries outside $TOP/"
}

uv_as_service_user() {
  (cd "$RELEASE_DIR" && runuser -u "$SERVICE_USER" -- env \
    HOME="$INSTALL_ROOT/.home" \
    UV_CACHE_DIR="$INSTALL_ROOT/.uv-cache" \
    UV_PYTHON_INSTALL_DIR="$INSTALL_ROOT/.uv-python" \
    "$UV" "$@")
}

install_release() {
  [[ -x $UV ]] || die "uv not found; run bootstrap.sh first"
  fetch_release
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating system user $SERVICE_USER"
    useradd --system --user-group --home-dir "$INSTALL_ROOT" --no-create-home \
      --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0755 -o root -g root "$INSTALL_ROOT" "$RELEASES"
  for dir in .home .uv-cache .uv-python; do
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_ROOT/$dir"
  done

  incomplete_release="$RELEASE_DIR"
  install -d -m 0755 "$RELEASE_DIR"
  tar -xzf "$workdir/$ARCHIVE" -C "$RELEASE_DIR" --strip-components=1 --no-same-owner
  [[ "$(cat "$RELEASE_DIR/VERSION")" == "$VERSION" ]] || die "VERSION file does not match $VERSION"
  [[ -f $RELEASE_DIR/frontend/index.html ]] || die "$ARCHIVE has no built frontend (frontend/index.html)"

  log "Creating Python environment (uv sync --frozen)"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$RELEASE_DIR"
  uv_as_service_user sync --managed-python --frozen --no-dev --compile-bytecode --project "$RELEASE_DIR"
  # The service only reads the release; root ownership keeps it immutable at runtime.
  chown -R root:root "$RELEASE_DIR"
  chmod -R go-w "$RELEASE_DIR"
  touch "$RELEASE_DIR/$COMPLETE_MARKER"
  incomplete_release=""
}

if [[ -e $RELEASE_DIR/$COMPLETE_MARKER ]]; then
  log "$VERSION is already installed; reactivating without download"
else
  if [[ -e $RELEASE_DIR ]]; then
    log "Removing incomplete earlier attempt at $RELEASE_DIR"
    rm -rf -- "$RELEASE_DIR"
  fi
  install_release
fi
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "service user $SERVICE_USER does not exist"

# Persistent state lives outside releases and is only seeded when missing.
new_config=0
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_ROOT"
chown root:"$SERVICE_USER" "$CONFIG_ROOT"
chmod 0750 "$CONFIG_ROOT"
install -d -m 0770 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_ROOT/preset"
if [[ ! -e $CONFIG_ROOT/config.toml ]]; then
  # The service can only write $CONFIG_ROOT/preset, so every file the UI saves lives there.
  sed -e 's|^preset = .*|preset = "preset/preset.json"|' \
    -e 's|^sequence = .*|sequence = "preset/sequence.json"|' \
    -e 's|^# palette = "palette.json"|# palette = "preset/palette.json"|' \
    "$RELEASE_DIR/config.example.toml" >"$workdir/config.toml"
  grep -qx 'preset = "preset/preset.json"' "$workdir/config.toml" || die "could not set render.preset in seeded config"
  grep -qx 'sequence = "preset/sequence.json"' "$workdir/config.toml" || die "could not set render.sequence in seeded config"
  install -m 0640 -o root -g "$SERVICE_USER" "$workdir/config.toml" "$CONFIG_ROOT/config.toml"
  new_config=1
  log "Seeded $CONFIG_ROOT/config.toml from config.example.toml"
fi
if [[ ! -e $CONFIG_ROOT/preset/preset.json ]]; then
  install -m 0660 -o "$SERVICE_USER" -g "$SERVICE_USER" "$RELEASE_DIR/preset.example.json" "$CONFIG_ROOT/preset/preset.json"
  log "Seeded $CONFIG_ROOT/preset/preset.json from preset.example.json"
fi

if (( ! new_config )); then
  log "Validating $CONFIG_ROOT/config.toml with $VERSION"
  (cd / && runuser -u "$SERVICE_USER" -- "$RELEASE_DIR/.venv/bin/python" -B "$RELEASE_DIR/run.py" \
    --check --config "$CONFIG_ROOT/config.toml") || die "$VERSION rejects the current config; active release unchanged"
fi

activate() {
  local target="$1"
  sed -e "s|@INSTALL_ROOT@|$INSTALL_ROOT|g" -e "s|@CONFIG_ROOT@|$CONFIG_ROOT|g" -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
    "$target/deploy/$SERVICE.service" >"$workdir/unit"
  install -m 0644 -o root -g root "$workdir/unit" "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$SERVICE.service" >/dev/null
  ln -sfn "$target" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
  touch "$target/$COMPLETE_MARKER"
  log "Active release: $(basename "$target")"
}

# Healthy = unit active, API and page answering, and no automatic restarts for a few seconds.
responding() {
  systemctl is-active --quiet "$SERVICE" && curl -fs -m 2 -o /dev/null "$HEALTH_URL" \
    && curl -fs -m 2 -o /dev/null "$PAGE_URL"
}

healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) restarts
  restarts="$(systemctl show -p NRestarts --value "$SERVICE")"
  while (( SECONDS < deadline )); do
    if responding; then
      sleep 3
      responding && [[ "$(systemctl show -p NRestarts --value "$SERVICE")" == "$restarts" ]] && return 0
    fi
    sleep 1
  done
  return 1
}

prune() {
  local count=0 marker dir
  for marker in $(ls -1t "$RELEASES"/*/"$COMPLETE_MARKER" 2>/dev/null || true); do
    dir="${marker%/"$COMPLETE_MARKER"}"
    count=$((count + 1))
    if (( count <= KEEP_RELEASES )) || [[ $dir == "$RELEASE_DIR" || $dir == "$previous" ]]; then
      continue
    fi
    log "Removing old release $(basename "$dir")"
    rm -rf -- "$dir"
  done
}

activate "$RELEASE_DIR"

if (( new_config )); then
  cat <<EOF

First install: the service is enabled but NOT started. Set the Art-Net target first:
  sudo nano $CONFIG_ROOT/config.toml
  sudo systemctl start $SERVICE
  systemctl status $SERVICE
  journalctl -u $SERVICE -f
EOF
  exit 0
fi

log "Restarting $SERVICE"
systemctl restart "$SERVICE"
if healthy; then
  log "$SERVICE is healthy on $VERSION"
  prune
  systemctl --no-pager --lines=5 status "$SERVICE" || true
  exit 0
fi

echo "install-release: health check failed for $VERSION" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
if [[ -n $previous && -e $previous/$COMPLETE_MARKER ]]; then
  log "Rolling back to $(basename "$previous")"
  activate "$previous"
  systemctl restart "$SERVICE"
  if healthy; then
    log "Rollback to $(basename "$previous") is healthy"
  else
    echo "install-release: rollback release is unhealthy too; check journalctl -u $SERVICE" >&2
  fi
fi
exit 1
