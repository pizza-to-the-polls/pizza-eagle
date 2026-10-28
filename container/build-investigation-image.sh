#!/usr/bin/env bash
# build-investigation-image.sh — build the pizza-eagle investigation image.
#
# usage: build-investigation-image.sh [--if-stale]
#
# Runs wherever podman runs — on the ops box as pizza-eagle-inv (bootstrap.sh
# and the nightly update unit call it via runuser/sudo; rootless podman keeps
# its image store under the invoking user's home), or directly on a dev
# machine. --if-stale rebuilds only when the Dockerfile is newer than the
# last build stamp (git pull updates mtimes, so a merged Dockerfile change
# triggers exactly one rebuild on the next nightly).
set -euo pipefail

cd "$(dirname "$0")"
IF_STALE=0
[[ "${1:-}" == "--if-stale" ]] && IF_STALE=1

IMAGE="${INV_IMAGE:-pizza-eagle-investigation}"
STAMP_FILE="${PE_IMAGE_STAMP:-${HOME:-/tmp}/.cache/pizza-eagle/image-built.stamp}"

if [[ $IF_STALE -eq 1 ]]; then
  if [[ -f "$STAMP_FILE" && ! ( Dockerfile.pi-investigation -nt "$STAMP_FILE" ) ]]; then
    echo "investigation image current (stamp $STAMP_FILE) — skipping rebuild"
    exit 0
  fi
fi

echo "building investigation image $IMAGE ..."
podman build \
  --label "org.pizza-eagle.component=investigation" \
  --label "org.pizza-eagle.built=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "$IMAGE" \
  -f Dockerfile.pi-investigation .
mkdir -p "$(dirname "$STAMP_FILE")"
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP_FILE"
echo "investigation image $IMAGE built (stamp: $(cat "$STAMP_FILE"))"
