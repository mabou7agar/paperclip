#!/bin/sh
# Root-owned host service. Reuse the configured container; never build/restart it.
set -eu
umask 077
SOURCE=/opt/paperclip-ubuntu-runner-integration
CONFIG=/etc/paperclip-ubuntu-runner/config.json
STATE=/var/lib/paperclip-ubuntu-runner
CONTAINER=${PAPERCLIP_UBUNTU_CONTAINER:?Set the existing runner container name}
case "$CONTAINER" in ''|*[!a-zA-Z0-9_.-]*) exit 64;; esac
mkdir -p "$STATE"
chmod 700 "$STATE"
/usr/bin/python3 -E -s -B "$SOURCE/wait-container.py" "$CONTAINER"
started=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER")
revision=$(find "$SOURCE" -type f ! -path '*/__pycache__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1)
config_revision=$(sha256sum "$CONFIG" | cut -d ' ' -f 1)
binding="$started $revision $config_revision"
if docker exec "$CONTAINER" test -f /opt/paperclip-ubuntu-runner/preview/stop.py; then
    docker exec "$CONTAINER" /usr/bin/python3 -E -s -B /opt/paperclip-ubuntu-runner/preview/stop.py
fi
if [ ! -f "$STATE/installed" ] || [ "$(cat "$STATE/installed")" != "$binding" ]; then
    fresh=
    if [ -f "$STATE/installed" ] && [ "$(cut -d ' ' -f 1 "$STATE/installed")" != "$started" ]; then
        fresh=--new-container
    fi
    stage=$(docker exec "$CONTAINER" mktemp -d /opt/paperclip-preview-install.XXXXXXXX)
    case "$stage" in /opt/paperclip-preview-install.[a-zA-Z0-9]*) ;; *) exit 65;; esac
    trap 'docker exec "$CONTAINER" rm -rf "$stage"' EXIT HUP INT TERM
    docker cp "$SOURCE/." "$CONTAINER:$stage/"
    docker cp "$CONFIG" "$CONTAINER:$stage/operator-config.json"
    # Expansion is empty or one fixed operator flag, never candidate input.
    docker exec "$CONTAINER" /usr/bin/python3 -E -s -B "$stage/install.py" \
        --config "$stage/operator-config.json" $fresh
    docker exec "$CONTAINER" rm -rf "$stage"
    trap - EXIT HUP INT TERM
    printf '%s\n' "$binding" > "$STATE/installed"
fi
exec docker exec "$CONTAINER" /usr/bin/python3 -E -s -B /opt/paperclip-ubuntu-runner/preview/server.py
