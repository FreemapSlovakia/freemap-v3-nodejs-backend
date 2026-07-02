#!/usr/bin/env bash
#
# Runs ON the fm3 server as the `freemap` user. Pulls the latest `main`,
# installs deps, rebuilds (native modules build against the server's libs),
# and restarts the systemd service.
#
# The restart needs this sudoers rule (as root, in /etc/sudoers.d/freemap-deploy):
#   freemap ALL=(root) NOPASSWD: /usr/bin/systemctl restart freemap
#
# Invoked by `pnpm deploy` (over SSH) and by .github/workflows/deploy.yml.
set -euo pipefail

cd "${DEPLOY_DIR:-/home/freemap/freemap-v3-nodejs-backend}"

git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart freemap

echo "Deployed $(git rev-parse --short HEAD)"
