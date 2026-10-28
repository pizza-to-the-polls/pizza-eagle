#!/usr/bin/env bash
# install-skills.sh — sync pi skill files from the repo checkout into
# /home/pizza-eagle/.pi/agent/skills/<name>/, so skill fixes merged to
# main go live with the next update instead of sitting dormant on the box
# (2026-11-02: PR #22's dispatch/SKILL.md would need hand-installs because
# bootstrap.sh §6 is the only installer — the same bootstrap-only gap class
# that install-units.sh fixed for unit files).
#
# Runs as root (caller context — the target dir is pizza-eagle-owned, 700).
# No version-control commands are involved, so the root-user "dubious
# ownership" repository trap does not apply.
#
# Design rules:
#   1. ADD/UPDATE only — never delete a box-side skill absent from the
#      repo. The pi skill dir may contain provisioned skills that never
#      came from this repo; orphan removal stays a human call.
#   2. cmp -s guard → skip identical files (idempotent no-op on a nightly
#      with no skill changes).
#   3. install -o pizza-eagle -g pizza-eagle for every file placed — files
#      in the bot user's skill dir must be pizza-eagle-owned, never
#      root-owned (root-owned files would break the next update as
#      pizza-eagle).
#   4. No daemon-reload equivalent needed — pi reads skills per session,
#      so the caller's bot restart is what makes a new skill visible.
#   5. Log every changed/new file to stdout (→ journald for the nightly
#      unit; → GitHub Actions log for the SSM dispatch).
set -euo pipefail

# Overridable for the test harness only — the box always uses the defaults.
REPO_DIR="${PE_REPO_DIR:-/opt/pizza-eagle}"
SKILL_TARGET="${PE_SKILL_TARGET:-/home/pizza-eagle/.pi/agent/skills}"
CHANGED=0

# Ownership flags: production runs as root (caller context) and must place
# pizza-eagle-owned files; a non-root test harness drops the flags so the
# same script can be exercised against a throwaway tree it owns. A plain
# string (not an array) keeps `set -u` happy on old bash (3.2 chokes on
# "${arr[@]}" when the array is empty).
OWN_ARGS=""
if [ "$(id -u)" -eq 0 ]; then
  OWN_ARGS="-o pizza-eagle -g pizza-eagle"
fi

for skill_dir in "$REPO_DIR"/skills/*/; do
  # Unmatched glob (no skills/ subdirs) stays literal — skip it.
  [ -d "$skill_dir" ] || continue

  skill_file="${skill_dir}SKILL.md"
  # A subdirectory without SKILL.md is not a skill — skip it.
  [ -f "$skill_file" ] || continue

  sname=$(basename "$skill_dir")
  target_dir="$SKILL_TARGET/$sname"
  target_file="$target_dir/SKILL.md"

  # Idempotence: identical content → nothing to do (no install, no log).
  if [ -f "$target_file" ] && cmp -s "$skill_file" "$target_file"; then
    continue
  fi

  install -d $OWN_ARGS -m 755 "$target_dir"
  install $OWN_ARGS -m 644 "$skill_file" "$target_file"
  echo "updated: $sname/SKILL.md"
  CHANGED=1
done

if [ "$CHANGED" -eq 0 ]; then
  echo "all skills current — no changes"
fi
