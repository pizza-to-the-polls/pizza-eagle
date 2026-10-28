import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RUNBOOK drift guard for the /etc/pizza-eagle/.env migration (issue #4).
 *
 * The env file is root-owned at /etc/pizza-eagle/.env (600) so the
 * pizza-eagle user — and therefore any pi investigation child — can never
 * read it. The rotation procedure in RUNBOOK.md must reflect that reality:
 *
 *   1. The fetch/redirect/chown/chmod/restart sequence must run as a single
 *      root shell (`sudo bash -c '...'`), NOT as a sequence of `sudo CMD`
 *      calls with a plain `>` redirect — the redirect is performed by the
 *      operator's (non-root) shell, which cannot write into the root-owned
 *      /etc/pizza-eagle/ directory. The file would end up owned by the
 *      operator (or the command would fail with EACCES), silently breaking
 *      the service boundary.
 *   2. The old user-owned /opt/pizza-eagle/.env must be explicitly removed,
 *      not left behind to drift.
 *   3. The restart must come after daemon-reload so the service actually
 *      picks up the re-rendered EnvironmentFile.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runbook = readFileSync(join(repoRoot, "RUNBOOK.md"), "utf8");
const bootstrap = readFileSync(join(repoRoot, "scripts", "bootstrap.sh"), "utf8");

/** The rotation block — the only place in the runbook where the atomic
 * fetch → redirect → chown → chmod → rm → daemon-reload → restart sequence
 * lives. Scope ordering checks to this block: "systemctl restart
 * pizza-eagle" legitimately appears earlier in the file ("How to restart
 * it"), and the rotation's own ordering must hold inside the block. */
const ROTATION_BLOCK = /sudo bash -c 'set -euo pipefail;[\s\S]*?systemctl restart pizza-eagle'/;

const OLD_ENV_PATH = "/opt/pizza-eagle/.env";
const NEW_ENV_PATH = "/etc/pizza-eagle/.env";

/** Extract the concatenated fenced code blocks from a markdown document.
 * Checks that distinguish "commands to run" from "prose about the command"
 * (e.g. the bare-redirect trap warning) must use this, not the raw text.
 * Info strings may contain digits (```python3, ```bash2, …), so the tag
 * class must include them or those blocks silently escape every check. */
function codeBlocks(md: string): string {
  const blocks: string[] = [];
  const fence = /```[a-z0-9+-]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md)) !== null) blocks.push(m[1]);
  return blocks.join("\n");
}

test("runbook: rotation uses a single root shell (sudo bash -c) for the atomic migration", () => {
  assert.match(
    runbook,
    ROTATION_BLOCK,
    "RUNBOOK.md: rotation block must wrap the whole pipeline (fetch → redirect → " +
      "chown → chmod → rm → daemon-reload → restart) in `sudo bash -c '...'` so " +
      "the > redirect into /etc/pizza-eagle/ runs as root, not as the operator",
  );
});

test("runbook: rotation does not redirect into the root-owned dir with a bare `>`", () => {
  // The trap: `sudo aws ... > /etc/pizza-eagle/.env` — the shell performing
  // the redirect is the operator's, not root's. Only fenced code blocks are
  // checked: the prose paragraph warns about the trap by *quoting* it, and
  // quoting a bad command in prose is not executing it.
  const bareRedirect = new RegExp(
    `sudo [^\\n]*>\\s*${NEW_ENV_PATH.replace(/\//g, "\\/")}`,
  );
  assert.doesNotMatch(
    codeBlocks(runbook),
    bareRedirect,
    "RUNBOOK.md: found `sudo ... > /etc/pizza-eagle/.env` in a code block — " +
      "the redirect runs as the non-root operator shell and fails with EACCES " +
      "(or worse, leaves a non-root-owned file). Use `sudo bash -c '...'` for " +
      "the whole pipeline.",
  );
});

test("runbook: rotation explicitly chowns root:root and chmods 600", () => {
  assert.match(
    runbook,
    /chown root:root \/etc\/pizza-eagle\/\.env/,
    "RUNBOOK.md: rotation must chown root:root the env file — " +
      "never assume the pre-existing owner",
  );
  assert.match(
    runbook,
    /chmod 600 \/etc\/pizza-eagle\/\.env/,
    "RUNBOOK.md: rotation must chmod 600 the env file",
  );
});

test("runbook: rotation removes the old user-owned env file", () => {
  assert.match(
    runbook,
    new RegExp(`rm -f ${OLD_ENV_PATH.replace(/\//g, "\\/")}`),
    "RUNBOOK.md: rotation must `rm -f /opt/pizza-eagle/.env` — " +
      "leaving it behind means a stale, user-readable copy of every secret",
  );
});

test("runbook: rotation restarts the service after daemon-reload", () => {
  // Scope to the rotation block: "How to restart it" (earlier in the file)
  // legitimately contains `sudo systemctl restart pizza-eagle` too.
  const block = ROTATION_BLOCK.exec(runbook)?.[0];
  assert.ok(
    block,
    "RUNBOOK.md: no `sudo bash -c '...'` rotation block found — see the " +
      "single-root-shell test",
  );
  const reload = block.indexOf("systemctl daemon-reload");
  const restart = block.indexOf("systemctl restart pizza-eagle");
  assert.ok(reload !== -1, "RUNBOOK.md: rotation must run `systemctl daemon-reload`");
  assert.ok(restart !== -1, "RUNBOOK.md: rotation must restart pizza-eagle");
  assert.ok(
    reload < restart,
    "RUNBOOK.md: rotation must daemon-reload BEFORE restarting pizza-eagle — " +
      "otherwise systemd may not have re-read the unit definition",
  );
});

test("runbook: documents the post-flight permission/ownership checks", () => {
  // The issue's verification steps are the source of truth — the runbook
  // must teach them, not just the write.
  assert.match(
    runbook,
    /ls -l \/etc\/pizza-eagle\/\.env/,
    "RUNBOOK.md: post-flight must show how to verify `-rw------- root root`",
  );
  assert.match(
    runbook,
    /systemctl is-active pizza-eagle/,
    "RUNBOOK.md: post-flight must show how to verify the service is active",
  );
  assert.match(
    runbook,
    /sudo -u pizza-eagle cat \/etc\/pizza-eagle\/\.env/,
    "RUNBOOK.md: post-flight must show how to verify the pizza-eagle user " +
      "cannot read the file (Permission denied)",
  );
});

test("runbook: mentions the new root-owned path, not just the old one", () => {
  assert.match(
    runbook,
    new RegExp(NEW_ENV_PATH.replace(/\//g, "\\/")),
    "RUNBOOK.md: must document /etc/pizza-eagle/.env as the live env file",
  );
  assert.match(
    runbook,
    /root-owned/,
    "RUNBOOK.md: must warn that the env file is root-owned",
  );
});

test("bootstrap.sh: renders the env file root-owned and removes the user-owned one", () => {
  assert.match(
    bootstrap,
    /chown root:root \/etc\/pizza-eagle\/\.env/,
    "bootstrap.sh: must chown root:root the rendered env file",
  );
  assert.match(
    bootstrap,
    /chmod 600 \/etc\/pizza-eagle\/\.env/,
    "bootstrap.sh: must chmod 600 the rendered env file",
  );
  assert.match(
    bootstrap,
    /rm -f "\$PTP_BOT_HOME\/\.env"/,
    "bootstrap.sh: must remove the old user-owned /opt/pizza-eagle/.env " +
      "(same file via $PTP_BOT_HOME)",
  );
  assert.doesNotMatch(
    bootstrap,
    /chown pizza-eagle:pizza-eagle \/etc\/pizza-eagle\/\.env/,
    "bootstrap.sh: must never hand the env file to the pizza-eagle user — " +
      "that defeats the whole root/600 boundary",
  );
});

test("bootstrap.sh: no plain `>` redirect into /etc/pizza-eagle/.env from a non-root shell", () => {
  assert.doesNotMatch(
    bootstrap,
    /sudo [^\n]*>\s*\/etc\/pizza-eagle\/\.env/,
    "bootstrap.sh: `sudo ... > /etc/pizza-eagle/.env` is the same trap as the " +
      "RUNBOOK — the redirect runs as the invoking user. bootstrap.sh already " +
      "runs as root (cloud-init user-data), so a bare redirect is fine here; " +
      "if you add sudo, use sudo bash -c.",
  );
});
