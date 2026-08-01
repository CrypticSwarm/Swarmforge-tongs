#!/bin/sh
# GIT_ASKPASS helper. git runs this to get the password for the push URL, whose
# username is already `x-access-token`.
#
# This exists so the token never appears on a command line -- /proc/<pid>/cmdline
# is readable by any process in this container, argv is not a secret channel.
set -eu
printf '%s\n' "${GITHUB_TONG_TOKEN:-}"
