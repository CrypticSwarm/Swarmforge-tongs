#!/bin/sh
# Runtime entrypoint. By the time this runs, the launcher's secret prologue has
# already read the FIFO and exported GIT_SIGNING_KEY.
#
# Why drop privileges: this tong writes new commit objects into the mounted
# workspace's .git. Running as root would leave those objects root-owned and break
# the anvil's next git write. Matching the workspace directory's own owner is the
# closest available proxy for the uid the anvil uses.
#
# The image is Alpine, so /bin/sh is busybox ash, which supports `pipefail`.
set -euo pipefail

WORKSPACE="${GIT_SIGNING_WORKSPACE:-/workspace}"

if [ ! -d "$WORKSPACE" ]; then
    echo "git-signing: workspace '$WORKSPACE' is not mounted; the tong definition needs 'mounts: [workspace:rw]'" >&2
    exit 1
fi

# Fail closed rather than silently continuing as root on a stat we cannot read.
owner="$(stat -c '%u:%g' "$WORKSPACE")" || {
    echo "git-signing: cannot stat workspace '$WORKSPACE'" >&2
    exit 1
}

# tmpfs, so the keyring never reaches a disk-backed layer. Created here rather
# than in the image because gpg refuses a home directory it does not own, or one
# that is group- or world-readable.
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

# Already unprivileged (the image was run with --user): nothing to drop to.
exec node /app/dist/src/index.js
