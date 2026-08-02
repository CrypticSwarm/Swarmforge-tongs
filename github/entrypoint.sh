#!/bin/sh
# By the time this runs, the launcher's secret prologue has exported GITHUB_TOKEN.
#
# Privileges are dropped to the workspace's owner because pushing writes a
# remote-tracking ref into .git; doing that as root would leave the ref root-owned
# and break the anvil's next git write.
#
# The image is Alpine, so /bin/sh is busybox ash, which supports `pipefail`.
set -euo pipefail

WORKSPACE="${GITHUB_TONG_WORKSPACE:-/workspace}"

if [ ! -d "$WORKSPACE" ]; then
    echo "github: workspace '$WORKSPACE' is not mounted; the tong definition needs 'mounts: [workspace:rw]'" >&2
    exit 1
fi

owner="$(stat -c '%u:%g' "$WORKSPACE")" || {
    echo "github: cannot stat workspace '$WORKSPACE'" >&2
    exit 1
}

# git needs a writable HOME for its own config lookups; keep it off the workspace
# and off any disk-backed layer.
HOME="/dev/shm/github-home"
export HOME
rm -rf "$HOME"
mkdir -p "$HOME"
chmod 700 "$HOME"

if [ "$(id -u)" = "0" ]; then
    chown "$owner" "$HOME"
    exec su-exec "$owner" node /app/dist/src/index.js
fi

exec node /app/dist/src/index.js
