#!/usr/bin/env bash
# Renders build/pizza-eagle.rendered.yaml: splices base64(gzip(scripts/bootstrap.sh))
# into the @@BOOTSTRAP_B64@@ marker inside the UserData block.
#
# GZIP (2026-10-30): EC2 caps UserData at 16384 bytes, and bootstrap.sh had
# grown to where the plain base64 blob alone was 15.5KB — every CFN deploy
# from main failed at the LaunchTemplate ("User data is limited to 16384
# bytes", InvalidUserData.Malformed — the 2026-10-30 feedflag-grant deploy
# rolled back on it). gzip+base64 puts the payload at ~5.3KB with 3x headroom;
# the UserData stub decodes with `base64 -d | gzip -d`.
#
# Single source of truth: edit scripts/bootstrap.sh, never the rendered blob
# (it's gitignored). Deploy from build/pizza-eagle.rendered.yaml, NOT from
# cloudformation/pizza-eagle.yaml — the raw template has no user-data.
#
# Validates the result with `aws cloudformation validate-template` (any
# identity with cloudformation:ValidateTemplate — ptp-agent works).
set -euo pipefail
cd "$(dirname "$0")/.."

B64=$(gzip -c scripts/bootstrap.sh | base64 | tr -d '\n') # portable (macOS base64 has no -w0)

# Guard: fail at RENDER time, not at CFN execution. 12000 b64 bytes leaves
# room for the stub and the CFN !Base64 re-encoding (x4/3) under the 16384
# API limit with margin.
if [ "${#B64}" -ge 12000 ]; then
  echo "render: gzipped+b64 bootstrap payload is ${#B64} bytes (guard: <12000) —" \
    "bootstrap.sh has grown too big; trim it or move logic off UserData" >&2
  exit 1
fi

mkdir -p build
python3 - "$B64" <<'PYEOF'
import sys

b64 = sys.argv[1]
tpl_path = "cloudformation/pizza-eagle.yaml"
out_path = "build/pizza-eagle.rendered.yaml"

tpl = open(tpl_path).read()
marker = "@@BOOTSTRAP_B64@@"
count = tpl.count(marker)
assert count == 1, f"expected exactly 1 {marker} in {tpl_path}, found {count}"

open(out_path, "w").write(tpl.replace(marker, b64))
print(f"wrote {out_path} (user-data {len(b64)} bytes b64)")
PYEOF

AWS_REGION=${AWS_REGION:-us-west-2} aws cloudformation validate-template \
  --template-body "file://${PWD}/build/pizza-eagle.rendered.yaml" >/dev/null
echo "validated OK — deploy with: aws cloudformation deploy --template-file build/pizza-eagle.rendered.yaml ..."
