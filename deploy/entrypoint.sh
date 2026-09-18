#!/bin/sh
set -eu

# The image's default user is the non-root `node` user. Keeping this wrapper
# tiny makes the normal path transparent and lets Compose override the uid/gid
# for a host-owned bind mount without adding a privileged helper or Docker
# socket dependency.
exec "$@"
