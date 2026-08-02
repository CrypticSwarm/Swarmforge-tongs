#!/bin/sh
# GIT_ASKPASS helper. git runs this to get the password for the push URL, whose
# username is already `x-access-token`.
#
# This exists so the token never appears on a command line -- /proc/<pid>/cmdline
# is readable by any process in this container, argv is not a secret channel.
set -eu

# Exit rather than print an empty line. An empty password is a credential git will
# happily send, so a missing variable would surface as a remote rejection rather
# than as the wiring fault it is.
if [ -z "${GITHUB_TONG_TOKEN:-}" ]; then
    echo "github: askpass was invoked with no token in its environment" >&2
    exit 1
fi

printf '%s\n' "$GITHUB_TONG_TOKEN"
