import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
