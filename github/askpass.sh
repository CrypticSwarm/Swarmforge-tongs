#!/bin/sh
# GIT_ASKPASS helper, so the token never reaches argv (/proc/<pid>/cmdline is readable).
set -eu

# git would send an empty password, hiding the wiring fault behind a remote rejection.
if [ -z "${GITHUB_TONG_TOKEN:-}" ]; then
    echo "github: askpass was invoked with no token in its environment" >&2
    exit 1
fi

printf '%s\n' "$GITHUB_TONG_TOKEN"
