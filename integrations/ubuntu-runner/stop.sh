#!/bin/sh
set -eu
CONTAINER=${PAPERCLIP_UBUNTU_CONTAINER:?Set the existing runner container name}
case "$CONTAINER" in ''|*[!a-zA-Z0-9_.-]*) exit 64;; esac
if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER")" = true ]; then
    docker exec "$CONTAINER" /usr/bin/python3 -E -s -B /opt/paperclip-ubuntu-runner/preview/stop.py
fi
