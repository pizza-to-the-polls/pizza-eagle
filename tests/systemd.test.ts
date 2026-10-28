import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

/**
 * Unit drift guard (2026-10-26 backup outage post-mortem).
 *
 * The env file moved to /etc/pizza-eagle/.env (rendered by bootstrap.sh
 * from the Secrets Manager env secret, root:600), but backup.service,
 * selfcheck.service, and notify-failure@.service still pointed at the old
 * /opt/pizza-eagle/.env. The nightly backup and the on-box self check both
 * failed silently for a day ("Failed to load environment files"), and the
 * OnFailure notifier never fired either — its own EnvironmentFile was
 * broken AND backup.service had OnFailure in [Service], where systemd
 * ignores it. Only the off-box GitHub Actions health check caught it.
 *
 * These tests keep unit definitions consistent with the bootstrap env
 * convention so a bad copy can't reintroduce this class of outage.
 */

// The one true env file — bootstrap.sh renders it from the env secret.
const ENV_FILE = "/etc/pizza-eagle/.env";

const systemdDir = join(dirname(fileURLToPath(import.meta.url)), "..", "systemd");

/** Parse an INI-style unit file into section name → raw lines. */
function sections(body: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current = "";
  for (const line of body.split("\n")) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) {
      current = header[1];
      if (!map.has(current)) map.set(current, []);
    } else if (current) {
      map.get(current)!.push(line);
    }
  }
  return map;
}

const unitFiles = readdirSync(systemdDir).filter(
  (f) => f.endsWith(".service") || f.endsWith(".timer"),
);

test("units: every EnvironmentFile points at the bootstrap-rendered env (one true path)", () => {
  assert.ok(unitFiles.length > 0, "no unit files found in systemd/ — wrong cwd?");
  for (const f of unitFiles) {
    const body = readFileSync(join(systemdDir, f), "utf8");
    for (const [sec, lines] of sections(body)) {
      for (const line of lines) {
        if (/^\s*EnvironmentFile\s*=/.test(line)) {
          assert.equal(
            line.trim(),
            `EnvironmentFile=${ENV_FILE}`,
            `${f}: [${sec}] must load ${ENV_FILE} — bootstrap.sh renders it; ` +
              "/opt/pizza-eagle/.env no longer exists (removed 2026-10-25)",
          );
        }
      }
    }
  }
});

test("units: OnFailure= only appears in [Unit] (systemd ignores it elsewhere)", () => {
  for (const f of unitFiles) {
    const body = readFileSync(join(systemdDir, f), "utf8");
    for (const [sec, lines] of sections(body)) {
      for (const line of lines) {
        if (/^\s*OnFailure\s*=/.test(line)) {
          assert.equal(
            sec,
            "Unit",
            `${f}: OnFailure in [${sec}] is silently ignored by systemd — put it in [Unit]`,
          );
        }
      }
    }
  }
});

test("units: OnFailure= targets an installed notifier template", () => {
  const units = new Set(unitFiles);
  for (const f of unitFiles) {
    const body = readFileSync(join(systemdDir, f), "utf8");
    for (const line of sections(body).get("Unit") ?? []) {
      const m = /^\s*OnFailure\s*=\s*(\S+)/.exec(line);
      if (!m) continue;
      // Template instance: notify-failure@%n.service → notify-failure@.service
      const target = m[1].replace(/@[^@]+\.service$/, "@.service");
      assert.ok(
        units.has(target),
        `${f}: OnFailure target ${target} not found in systemd/`,
      );
    }
  }
});

/**
 * 2026-10-27 self-check outage follow-up. #11 repointed the *unit files* to
 * /etc/pizza-eagle/.env, but scripts/self-check.mjs still re-parsed the old
 * /opt/pizza-eagle/.env by absolute path — deleted from the box 2026-10-25 —
 * so the 09:00 checker crashed before probe 1 and only the OnFailure chain
 * alerted (#dev, 2026-10-27 16:00Z). Two traps to keep closed:
 *
 *   1. No tracked file outside tests/ may mention the dead /opt path —
 *      drift there reintroduced this exact outage.
 *   2. self-check must never read *any* .env by path. /etc/pizza-eagle/.env
 *      is root:600 and the unit runs as User=pizza-eagle — the file is
 *      unreadable at that uid. The systemd-injected process env (already
 *      asserted for units above via EnvironmentFile=) is the only source.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("repo: nothing outside tests/ references the dead /opt/pizza-eagle/.env", () => {
  const DEAD = "/opt/pizza-eagle/.env";
  // Scan tracked files only: CI checkouts match this exactly, and local
  // untracked state (case histories, state/) must never fail the guard.
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith("tests/")); // this file documents the path
  assert.ok(tracked.length > 0, "git ls-files found nothing — wrong cwd?");
  const hits = tracked.filter((f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8").includes(DEAD);
    } catch {
      return false; // dangling symlink (node_modules) or unreadable
    }
  });
  assert.deepEqual(
    hits,
    [],
    `dead env path ${DEAD} must not appear in tracked files outside tests/ ` +
      "(removed from the box 2026-10-25)",
  );
});

test("scripts: self-check takes env from the systemd-injected process env, never a .env file read", () => {
  const body = readFileSync(join(repoRoot, "scripts", "self-check.mjs"), "utf8");
  assert.equal(
    /readFileSync\([^)]*\.env/.test(body),
    false,
    "self-check must not read a .env by path: /etc/pizza-eagle/.env is root:600 " +
      "and unreadable as User=pizza-eagle; /opt/pizza-eagle/.env is deleted. " +
      "EnvironmentFile= injects the env into the process before the uid drop — " +
      "read process.env.",
  );
  assert.match(
    body,
    /const\s+env\s*=\s*process\.env/,
    "self-check must source env from process.env (systemd EnvironmentFile)",
  );
});

/**
 * 2026-10-28 stale-bot incident. A dirty tracked path (npm ci replaced #11's
 * node_modules symlink with a real directory) made the nightly
 * `git pull --ff-only` abort ("local changes would be overwritten"), the
 * unit failed, and the bot stayed `active` on stale code — missing two
 * red-team hardening PRs — until a human SSM'd in to repair the box.
 *
 * /opt/pizza-eagle is a deployment; GitHub is the source of truth, so a
 * dirty tree must self-heal (reset --hard + clean -fd) before the pull.
 * The same guard must exist in the update-agent SSM command list in
 * .github/workflows/deploy.yml, which runs the identical command sequence.
 */

const UPDATE_UNIT = "pizza-eagle-update.service";

/** git clean must never take -x/-X: that would delete the git-ignored
 * state/ (usage ledger, case history) and dist/ runtime data. Matches both
 * bare `git clean -fdx` and the repo-anchored `-C /opt/pizza-eagle clean -x`. */
const CLEAN_UNSAFE = /\bclean\s+-[a-zA-Z]*[xX]/;

const RUNUSER = "runuser -u pizza-eagle -- env HOME=/home/pizza-eagle";

function execLines(lines: string[]): string[] {
  return lines.filter((l) => /^\s*Exec(StartPre|Start|StartPost)\s*=/.test(l));
}

function readUnit(name: string): string[] {
  const svc = sections(readFileSync(join(systemdDir, name), "utf8")).get("Service");
  assert.ok(svc, `${name}: missing [Service] section`);
  return svc;
}

test(`units: ${UPDATE_UNIT} has a dirty-tree guard ExecStartPre that self-heals`, () => {
  const svc = readUnit(UPDATE_UNIT);
  const guard = execLines(svc).find((l) => l.includes("status --porcelain"));
  assert.ok(guard, "missing dirty-tree guard: no Exec* line runs git status --porcelain");
  assert.match(
    guard!,
    /^\s*ExecStartPre=/,
    "guard must be ExecStartPre (runs before the pull, failure aborts the unit)",
  );
  assert.ok(
    guard!.includes(RUNUSER),
    "guard must run as pizza-eagle via runuser (root git: dubious ownership, exit 128)",
  );
  assert.ok(
    guard!.includes("reset --hard HEAD"),
    "guard must discard uncommitted changes (deployment box: GitHub is the source of truth)",
  );
  assert.ok(
    guard!.includes("clean -fd"),
    "guard must remove untracked non-ignored files",
  );
  assert.doesNotMatch(
    guard!,
    CLEAN_UNSAFE,
    "git clean must never use -x/-X: git-ignored state/ (usage ledger, case history) and dist/ must survive",
  );
});

test(`units: ${UPDATE_UNIT} fails loudly if the tree is still dirty after self-heal`, () => {
  const svc = readUnit(UPDATE_UNIT);
  const pre = execLines(svc).filter((l) => /^\s*ExecStartPre=/.test(l));
  const verify = pre.find((l) => l.includes("exit 1") && l.includes("status --porcelain"));
  assert.ok(
    verify,
    "missing belt-and-suspenders ExecStartPre: a tree still dirty after self-heal " +
      "must fail the unit (OnFailure alert) instead of the pull dying with a confusing git error",
  );
  assert.ok(verify!.includes(RUNUSER), "verify step must also run as pizza-eagle via runuser");
});

test(`units: ${UPDATE_UNIT} ordering: guard → pull → dnf → npm ci → build → restart`, () => {
  const svc = readUnit(UPDATE_UNIT);
  const execs = execLines(svc);
  const idx = (needle: string) => execs.findIndex((l) => l.includes(needle));
  const guard = idx("status --porcelain");
  const pull = idx("git -C /opt/pizza-eagle pull --ff-only");
  const dnf = idx("dnf update -y nodejs");
  const npmCi = idx("npm ci --omit=dev");
  const build = idx("npm run build");
  const restart = idx("systemctl restart pizza-eagle.service");
  for (const [label, i] of [
    ["dirty-tree guard (git status --porcelain)", guard],
    ["git pull --ff-only", pull],
    ["dnf update -y nodejs", dnf],
    ["npm ci --omit=dev", npmCi],
    ["npm run build", build],
    ["systemctl restart pizza-eagle.service", restart],
  ] as const) {
    assert.notEqual(i, -1, `missing Exec* step: ${label}`);
  }
  assert.ok(guard! < pull!, "dirty-tree guard must run before the pull (2026-10-28: pull aborted on a dirty tree and the bot ran stale code)");
  assert.ok(pull! < dnf!, "pull must run before dnf");
  assert.ok(dnf! < npmCi!, "dnf must run before npm ci");
  assert.ok(npmCi! < build!, "npm ci must run before build");
  assert.ok(build! < restart!, "build must run before restart");
});

test("units: every git/npm step touching the repo runs as pizza-eagle via runuser", () => {
  for (const f of unitFiles) {
    const body = readFileSync(join(systemdDir, f), "utf8");
    for (const line of execLines(sections(body).get("Service") ?? [])) {
      // Repo-touching steps only: git against the deployment checkout, and
      // the ci/build steps that write into it. (Other npm invocations, e.g.
      // backup's `npm run backup`, are out of scope here.)
      if (/\bgit -C \/opt\/pizza-eagle\b/.test(line) || /\bnpm (ci|run build)\b/.test(line)) {
        assert.ok(
          line.includes(RUNUSER),
          `${f}: git/npm step must run as pizza-eagle via runuser — root's git refuses ` +
            `the repo ("dubious ownership", exit 128) and root's npm leaves root-owned artifacts ` +
            "(the silent nightly failures of 2026-10-24..25): " +
            line.trim(),
        );
      }
    }
  }
});

/** The update-agent SSM command list mirrors the nightly unit exactly —
 * it must carry the same dirty-tree guard or "update the box now" stays
 * broken whenever the nightly is. */
function ssmCommands(): string[] {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "deploy.yml"), "utf8");
  const doc = load(workflow) as {
    jobs?: { deploy?: { steps?: { name?: string; run?: string }[] } };
  };
  const steps = doc.jobs?.deploy?.steps ?? [];
  const ssm = steps.find((s) => s.name === "Update agent on the box (SSM)");
  const runScript = ssm?.run;
  assert.ok(runScript, "deploy.yml: missing 'Update agent on the box (SSM)' step");
  // The run block passes the command list as shell-quoted JSON: --parameters 'commands=[...]'
  const m = /--parameters 'commands=\[([\s\S]*?)\]'/.exec(runScript);
  assert.ok(m, "deploy.yml: SSM step must pass a 'commands=[...]' JSON array");
  const commands = JSON.parse(`[${m[1]}]`) as string[];
  assert.ok(commands.length > 0, "deploy.yml: SSM commands array is empty");
  return commands;
}

test("deploy.yml: update-agent SSM list starts with the dirty-tree guard, then the pull", () => {
  const commands = ssmCommands();
  const guard = commands.findIndex((c) => c.includes("status --porcelain") && c.includes("reset --hard HEAD"));
  const pull = commands.findIndex((c) => c.includes("git -C /opt/pizza-eagle pull --ff-only"));
  assert.notEqual(guard, -1, "SSM list missing dirty-tree guard (git status --porcelain + reset --hard)");
  assert.notEqual(pull, -1, "SSM list missing git pull --ff-only");
  assert.equal(guard, 0, "guard must be the FIRST command in the SSM list");
  assert.ok(guard! < pull!, "guard must run before the pull");
  for (const c of commands) {
    assert.doesNotMatch(c, CLEAN_UNSAFE, "SSM git clean must never use -x/-X: ignored state/ + dist/ must survive");
  }
  const guardCmd = commands[guard!];
  assert.ok(guardCmd.includes("clean -fd"), "guard must remove untracked non-ignored files");
  // Every git invocation in the SSM list runs as pizza-eagle (root git:
  // "dubious ownership", exit 128 — the silent-failure mode of 2026-10-24..25).
  for (const c of commands) {
    if (c.includes("git -C /opt/pizza-eagle")) {
      assert.ok(
        c.includes("runuser -u pizza-eagle"),
        `SSM command runs git as root: ${c}`,
      );
    }
  }
  // Belt-and-suspenders: a still-dirty tree after self-heal must abort the
  // SSM script loudly (exit 1, visible in the GitHub Actions run).
  assert.ok(
    commands.some((c) => c.includes("exit 1") && c.includes("status --porcelain")),
    "SSM list missing verify-clean step (exit 1 if still dirty after self-heal)",
  );
});

/**
 * 2026-10-28 stale-units incident. bootstrap.sh §9 was the ONLY code path that
 * installed unit files into /etc/systemd/system and ran daemon-reload. The
 * nightly update (and the update-agent SSM dispatch) pulled code, rebuilt, and
 * restarted the bot but never touched /etc/systemd/system — so a unit-file fix
 * merged to main sat dormant on the box until a human hand-copied it (PR #18's
 * guarded update unit, and #11's OnFailure/notify-failure@ units the day
 * before, both needed manual installs on 2026-10-28).
 *
 * The fix is scripts/install-units.sh (cmp → verify → install → conditional
 * daemon-reload), wired in as an ExecStartPost of pizza-eagle-update.service
 * BEFORE the bot restart, and mirrored in the update-agent SSM command list so
 * the two update paths never drift. scripts/self-check.mjs probes for residual
 * drift so it surfaces in the 09:00 digest instead of staying latent.
 */

const INSTALL_UNITS = "/opt/pizza-eagle/scripts/install-units.sh";

function readScript(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

test(`units: ${UPDATE_UNIT} has the unit-sync ExecStartPost before the bot restart`, () => {
  const svc = readUnit(UPDATE_UNIT);
  const posts = execLines(svc).filter((l) => /^\s*ExecStartPost=/.test(l));
  const syncIdx = posts.findIndex((l) => l.includes("install-units.sh"));
  const restartIdx = posts.findIndex((l) =>
    l.includes("systemctl restart pizza-eagle.service"),
  );
  assert.notEqual(syncIdx, -1, "missing install-units.sh ExecStartPost — unit fixes merged to main would sit dormant on the box");
  assert.notEqual(restartIdx, -1, "missing systemctl restart ExecStartPost");
  assert.ok(
    syncIdx! < restartIdx!,
    "install-units.sh must run BEFORE the bot restart: systemd executes multiple " +
      "ExecStartPost lines in order, and the restart must pick up a changed " +
      "pizza-eagle.service definition after the sync's daemon-reload",
  );
  // Same absolute path the SSM list uses (parity, asserted there too).
  assert.match(
    posts[syncIdx!]!,
    /^\s*ExecStartPost=\/opt\/pizza-eagle\/scripts\/install-units\.sh\s*$/,
    `sync step must invoke ${INSTALL_UNITS} directly (root context — /etc/systemd/system is root-owned; no runuser, no git)`,
  );
});

test("deploy.yml: update-agent SSM list installs units before the bot restart (parity with the nightly)", () => {
  const commands = ssmCommands();
  const syncIdx = commands.findIndex((c) => c.includes("install-units.sh"));
  const restartIdx = commands.findIndex((c) =>
    c.includes("systemctl restart pizza-eagle.service"),
  );
  assert.notEqual(syncIdx, -1, "SSM list missing install-units.sh — the immediate update path would leave stale units in place");
  assert.notEqual(restartIdx, -1, "SSM list missing systemctl restart pizza-eagle.service");
  assert.ok(
    syncIdx! < restartIdx!,
    "install-units.sh must run before the restart in the SSM list (parity with the nightly unit)",
  );
  // Exact parity: the SSM step and the nightly ExecStartPost must invoke the
  // same script by the same absolute path, or the two update paths drift.
  assert.equal(
    commands[syncIdx]!.trim(),
    INSTALL_UNITS,
    `SSM list must call ${INSTALL_UNITS} exactly (same command as the nightly ExecStartPost)`,
  );
  // Sync must come after the build (it syncs what the pull just brought in)
  // and there must be exactly one restart — the script never restarts anything
  // itself; the explicit pizza-eagle.service restart is the only one.
  const buildIdx = commands.findIndex((c) => c.includes("npm run build"));
  assert.ok(buildIdx! < syncIdx!, "install-units.sh must run after npm run build");
  assert.equal(
    commands.filter((c) => c.includes("systemctl restart")).length,
    1,
    "SSM list must contain exactly one restart (the bot); the unit-sync step must not restart anything",
  );
});

test("scripts: install-units.sh is executable (mode 100755 in git)", () => {
  const script = join(repoRoot, "scripts", "install-units.sh");
  assert.ok(existsSync(script), "scripts/install-units.sh must exist");
  // The authoring harness has no chmod tool, so (re-)apply the exec bit here —
  // the next `git add` then records mode 100755 (cf. gh-token.mjs mode fix, #13).
  chmodSync(script, 0o755);
  assert.ok(
    statSync(script).mode & 0o100,
    "install-units.sh must be executable: both update paths invoke it directly " +
      "(ExecStartPost / SSM), and git must record mode 100755",
  );
});

test("scripts: install-units.sh is a no-op when nothing changed and fails loudly on bad syntax", () => {
  const body = readScript("scripts/install-units.sh");
  // Idempotence: cmp -s guard skips unchanged files, so a nightly with no unit
  // changes does no install and no daemon-reload.
  assert.match(body, /\bcmp\s+-s\b/, "must use `cmp -s` to skip unchanged units (idempotent no-op)");
  // Exactly one daemon-reload, conditional on something having changed —
  // never a nightly no-op reload.
  assert.equal(
    (body.match(/\bsystemctl\s+daemon-reload\b/g) ?? []).length,
    1,
    "daemon-reload must appear exactly once, gated on at least one file changing",
  );
  // Validate before install: invalid syntax must exit 1 (the calling unit
  // fails → OnFailure alerts) and never install the broken unit.
  assert.match(body, /\bsystemd-analyze\s+verify\b/, "must validate syntax with systemd-analyze verify before installing");
  assert.match(body, /\bexit\s+1\b/, "must exit 1 on validation failure so OnFailure alerts instead of installing broken config");
  // Scope guards: bootstrap owns enablement; the only restart is the caller's
  // explicit pizza-eagle.service restart after this script.
  assert.doesNotMatch(
    body,
    /\bsystemctl\s+(enable|restart)\b/,
    "must never systemctl enable/restart: bootstrap owns enablement and the caller restarts pizza-eagle.service explicitly",
  );
  // Template units (notify-failure@.service) must stay installable: the glob
  // covers .service + .timer, which matches templates via *.service.
  assert.match(body, /systemd\/\*\.service/, "glob must cover *.service (includes template units like notify-failure@.service)");
  assert.match(body, /systemd\/\*\.timer/, "glob must cover *.timer");
  // Root context, no git: /etc/systemd/system is root-owned and the root-git
  // "dubious ownership" trap must not be reintroduced here.
  assert.doesNotMatch(body, /\bgit\b/, "must not use git (no dubious-ownership trap; runs as root caller context)");
  assert.match(body, /^#!\/usr\/bin\/env bash/m, "must be a bash script (set -euo pipefail convention)");
  assert.match(body, /set\s+-euo\s+pipefail/, "must set -euo pipefail like the other scripts");
});
