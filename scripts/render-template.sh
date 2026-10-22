#!/usr/bin/env bash
# Renders build/ptp-ops.rendered.yaml: splices base64(scripts/bootstrap.sh)
# into the @@BOOTSTRAP_B64@@ marker inside the UserData block.
#
# Single source of truth: edit scripts/bootstrap.sh, never the rendered blob
# (it's gitignored). Deploy from build/ptp-ops.rendered.yaml, NOT from
# cloudformation/ptp-ops.yaml — the raw template has no user-data.
#
# Validates the result with `aws cloudformation validate-template` (any
# identity with cloudformation:ValidateTemplate — ptp-agent works).
set -euo pipefail
cd "$(dirname "$0")/.."

B64=$(base64 < scripts/bootstrap.sh | tr -d '\n') # portable (macOS base64 has no -w0)

mkdir -p build
python3 - "$B64" <<'PYEOF'
import sys

b64 = sys.argv[1]
tpl_path = "cloudformation/ptp-ops.yaml"
out_path = "build/ptp-ops.rendered.yaml"

tpl = open(tpl_path).read()
marker = "@@BOOTSTRAP_B64@@"
count = tpl.count(marker)
assert count == 1, f"expected exactly 1 {marker} in {tpl_path}, found {count}"

open(out_path, "w").write(tpl.replace(marker, b64))
print(f"wrote {out_path} (user-data {len(b64)} bytes b64)")
PYEOF

AWS_REGION=${AWS_REGION:-us-west-2} aws cloudformation validate-template \
  --template-body "file://${PWD}/build/ptp-ops.rendered.yaml" >/dev/null
echo "validated OK — deploy with: aws cloudformation deploy --template-file build/ptp-ops.rendered.yaml ..."
