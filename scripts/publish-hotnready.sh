#!/usr/bin/env bash
# publish-hotnready.sh <src-dir> <slug> ["commit message"]
#
# One-shot publisher to the hotnready GitHub Pages sandbox — the bot's
# unreviewed publishing outlet by design (fresh box or old, P4 decision
# 2026-10-23). Mints a scoped 1h installation token internally; the agent
# calls this from a case workdir with the finished site/page folder.
#
# Convention enforced softly here: each publish lives in its OWN folder
# (<slug>); existing folders are only replaced when re-publishing the same
# slug. Leave human-maintained folders to humans.
set -euo pipefail

SRC="$1"; SLUG="$2"; MSG="${3:-"pizza-eagle: publish $SLUG"}"

[ -d "$SRC" ] || { echo "FATAL: $SRC is not a directory" >&2; exit 1; }
case "$SLUG" in ""|*[!a-z0-9-]*) echo "FATAL: slug must be lowercase a-z 0-9 -" >&2; exit 1;; esac
[ -f "$SRC/index.html" ] || echo "note: no index.html in $SRC — the URL won't render a page" >&2

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GH_TOKEN=$(node "$REPO_ROOT/scripts/gh-token.mjs" --repo pizza-to-the-polls/hotnready 2>/dev/null) \
  || { echo "FATAL: token mint failed (is GH_APP_ID set?)" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
GITID=(-c user.name="pizza-eagle-agent" -c user.email="5434163+pizza-eagle-agent[bot]@users.noreply.github.com")

git clone -q --depth 1 https://github.com/pizza-to-the-polls/hotnready.git "$WORK/hr"
rm -rf "$WORK/hr/$SLUG"
cp -r "$SRC" "$WORK/hr/$SLUG"
git -C "$WORK/hr" "${GITID[@]}" add -A
git -C "$WORK/hr" "${GITID[@]}" commit -q -m "$MSG"
# tr -d newline is load-bearing: GNU base64 wraps at 76 cols and an embedded
# newline in the header makes libcurl fail with bad-function-argument
git -C "$WORK/hr" -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')" \
  push -q origin HEAD:refs/heads/main

echo "published: https://pizza-to-the-polls.github.io/hotnready/$SLUG/"
echo "(GitHub Pages rebuilds in ~1-2 minutes)"
