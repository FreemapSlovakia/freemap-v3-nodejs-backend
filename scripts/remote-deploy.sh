#!/usr/bin/env bash
#
# Runs ON the fm6 server as the `freemap` user: installs deps, rebuilds (native
# modules build against the server's libs), and restarts the systemd service.
#
# The caller is responsible for `git pull` BEFORE invoking this script, so the
# script is never rewritten by git mid-run (which would shift the file under
# bash and corrupt execution). See `pnpm deploy` and .github/workflows/deploy.yml.
#
# The restart needs this sudoers rule (as root, in /etc/sudoers.d/freemap-deploy):
#   freemap ALL=(root) NOPASSWD: /usr/bin/systemctl restart freemap
set -euo pipefail

# Load fnm (provides node/pnpm). Non-interactive SSH and CI shells don't source
# ~/.bashrc where fnm is normally set up, so do it explicitly here.
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --shell bash)"
fnm use default

cd "${DEPLOY_DIR:-/home/freemap/freemap-v3-nodejs-backend}"

pnpm install --frozen-lockfile

# gdal-async's prebuilt binary bundles a GDAL whose libtiff lacks the ZSTD
# codec, so it can't read our ZSTD-compressed DTM tiles. Rebuild just that
# module from source against the system GDAL (which has ZSTD). Requires
# libgdal-dev (gdal-config) + a C++ toolchain on the server.
npm_config_build_from_source=true npm_config_shared_gdal=true \
  pnpm rebuild gdal-async

pnpm build
sudo systemctl restart freemap

echo "Deployed $(git rev-parse --short HEAD)"
