#!/usr/bin/env node
/**
 * ga.mjs — read-only Google Analytics (GA4) helper for pizza-eagle / Pizza Eagle.
 *
 * Why a helper at all: the GA Data API needs a signed OAuth2 JWT per query,
 * which is clumsy to hand-run. This signs, fetches a token (scope is
 * analytics.readonly ONLY — matches the ga-readonly service account), runs
 * one report, prints JSON, exits. No dependencies (plain node — the ops box
 * installs dev deps with --omit=dev).
 *
 * Service account path: GA_SA_JSON, default ~/.config/ptp/ga-readonly.json
 * (bootstrap.sh writes it on the ops box from Secrets Manager).
 *
 * Usage:
 *   node ga.mjs accounts
 *       list accounts + properties the SA can see (find property IDs)
 *   node ga.mjs report --property <id> [--dim name ...] [--metric name ...]
 *       [--start 2026-10-01|Nd|today] [--end YYYY-MM-DD|today] [--limit N]
 *       [--filter country=US] [--filter pagePath=/donate]   (comma => in-list)
 *   node ga.mjs realtime --property <id> [--dim ...] [--metric ...] [--limit N]
 *
 * --property falls back to GA_PROPERTY_ID. Output: API JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";

function usage(code = 1) {
  console.log(`usage:
  ga.mjs accounts
  ga.mjs report --property <id> [--dim name ...] [--metric name ...]
      [--start YYYY-MM-DD|Nd|today] [--end YYYY-MM-DD|today]
      [--filter dim=value ... (comma-sep value => in-list)] [--limit N]
  ga.mjs realtime --property <id> [--dim ...] [--metric ...] [--limit N]

env:
  GA_SA_JSON      service account JSON path (default ~/.config/ptp/ga-readonly.json)
  GA_PROPERTY_ID  default property id when --property is omitted`);
  process.exit(code);
}

function loadSA() {
  const p = process.env.GA_SA_JSON ?? `${homedir()}/.config/ptp/ga-readonly.json`;
  let sa;
  try {
    sa = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`cannot read service account at ${p}: ${e.message}`);
    process.exit(2);
  }
  if (!sa.client_email || !sa.private_key) {
    console.error(`service account at ${p} is missing client_email/private_key`);
    process.exit(2);
  }
  return sa;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function getToken(sa) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) {
    console.error(`token exchange failed (${res.status}): ${JSON.stringify(tok)}`);
    process.exit(3);
  }
  return tok.access_token;
}

/** argv like ["report","--dim","country","--limit","10"] → {cmd, flags} */
function parseArgs(argv) {
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      console.error(`unexpected argument: ${a}`);
      usage();
    }
    const k = a.slice(2);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`missing value for ${a}`);
      usage();
    }
    (flags[k] ??= []).push(v);
  }
  return { cmd, flags };
}

function resolveDate(spec) {
  if (!spec) return undefined;
  if (spec === "today") return new Date().toISOString().slice(0, 10);
  const rel = spec.match(/^(\d+)d$/);
  if (rel) {
    const d = new Date(Date.now() - Number(rel[1]) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    console.error(`bad date "${spec}" (want YYYY-MM-DD | Nd | today)`);
    usage();
  }
  return spec;
}

/** "country=US" / "country=US,CA" → a dimension filter */
function dimensionFilter(spec) {
  const eq = spec.indexOf("=");
  if (eq < 1) {
    console.error(`bad --filter "${spec}" (want name=value)`);
    usage();
  }
  const name = spec.slice(0, eq);
  const values = spec.slice(eq + 1).split(",");
  const filter = values.length > 1
    ? { inListFilter: { values } }
    : { stringFilter: { matchType: "EXACT", value: values[0] } };
  return { andGroup: { expressions: [{ filter: { fieldName: name, ...filter } }] } };
}

async function api(token, url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`GA API ${res.status}: ${JSON.stringify(out)}`);
    process.exit(4);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") usage(0);
  const { cmd, flags } = parseArgs(argv);
  const sa = loadSA();
  const token = await getToken(sa);

  if (cmd === "accounts") {
    const out = await api(token, `${ADMIN_BASE}/accountSummaries`);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const property = (flags.property?.[0] ?? process.env.GA_PROPERTY_ID)?.replace(/^properties\//, "");
  if (!property) {
    console.error("no --property and no GA_PROPERTY_ID (run `ga.mjs accounts` to find it)");
    usage();
  }

  const dimensions = (flags.dim ?? []).map((name) => ({ name }));
  const metrics = (flags.metric ?? ["activeUsers"]).map((name) => ({ name }));
  const limit = flags.limit ? Number(flags.limit[0]) : 25;
  const filters = (flags.filter ?? []).map(dimensionFilter);

  if (cmd === "report") {
    const body = {
      dateRanges: [{
        startDate: resolveDate(flags.start?.[0] ?? "7d"),
        endDate: resolveDate(flags.end?.[0] ?? "today"),
      }],
      dimensions,
      metrics,
      limit,
      ...(filters.length ? { dimensionFilter: {
        andGroup: { expressions: filters },
      } } : {}),
    };
    const out = await api(token, `${DATA_BASE}/properties/${property}:runReport`, body);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === "realtime") {
    const body = {
      dimensions,
      metrics,
      limit,
      ...(filters.length ? { dimensionFilter: {
        andGroup: { expressions: filters },
      } } : {}),
    };
    const out = await api(token, `${DATA_BASE}/properties/${property}:runRealtimeReport`, body);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  usage();
}

await main();