#!/bin/sh
# busybox ash supports `pipefail`.
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

# git needs a writable HOME; keep it on tmpfs, off the workspace.
HOME="/dev/shm/github-home"
export HOME
rm -rf "$HOME"
mkdir -p "$HOME"
chmod 700 "$HOME"

# Drop to the workspace owner so refs written into .git stay the anvil's to write.
if [ "$(id -u)" = "0" ]; then
    chown "$owner" "$HOME"
    exec su-exec "$owner" node /app/dist/src/index.js
fi

exec node /app/dist/src/index.js
