#!/bin/sh
# Drops to the workspace owner's uid so .git objects written here are not root-owned.
# /bin/sh is busybox ash, which supports pipefail.
set -euo pipefail

WORKSPACE="${GIT_SIGNING_WORKSPACE:-/workspace}"

if [ ! -d "$WORKSPACE" ]; then
    echo "git-signing: workspace '$WORKSPACE' is not mounted; the tong definition needs 'mounts: [workspace:rw]'" >&2
    exit 1
fi

owner="$(stat -c '%u:%g' "$WORKSPACE")" || {
    echo "git-signing: cannot stat workspace '$WORKSPACE'" >&2
    exit 1
}

# tmpfs keeps the keyring off disk; made at runtime since gpg wants a 0700 home it owns.
GNUPGHOME="/dev/shm/git-signing-gnupg"
# git needs a writable HOME for its own config lookups; keep it off the workspace.
HOME="/dev/shm/git-signing-home"
export GNUPGHOME HOME

for dir in "$GNUPGHOME" "$HOME"; do
    rm -rf "$dir"
    mkdir -p "$dir"
    chmod 700 "$dir"
done

if [ "$(id -u)" = "0" ]; then
    chown "$owner" "$GNUPGHOME" "$HOME"
    exec su-exec "$owner" node /app/dist/src/index.js
fi

# Already unprivileged (run with --user).
exec node /app/dist/src/index.js
