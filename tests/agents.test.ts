import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prose-adjacent drift guard for the size-first routing layer (issue #21).
 *
 * Routing for coding asks lives in agent/AGENTS.md prose — the pi agent
 * reads it every run and follows it. There is no src/ code to unit-test
 * (prose-first by design: a follow-up issue can add code-level
 * classification if sizing proves unreliable in practice), so these tests
 * assert the documented behaviors exist and stay put. The 2026-10-24 ask
 * (pizzabase logging + polls.pizza GA4) was killed by the 20-minute
 * investigation timeout twice — exit 143 both times — because the old
 * scope rule punted multi-part asks back to the human to re-mention.
 * These tests keep the replacement (classify → size → inline-or-dispatch)
 * from silently regressing to that behavior.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsMd = readFileSync(join(repoRoot, "agent", "AGENTS.md"), "utf8");

test("AGENTS.md routing section: names all four behaviors (classify, size, inline, dispatch)", () => {
  assert.ok(
    agentsMd.includes("## Routing — investigation vs. code change"),
    "AGENTS.md must have a routing section for investigation vs. code change",
  );
  assert.match(agentsMd, /Classify/, "must have a classify step");
  assert.match(
    agentsMd,
    /20 minutes|20-minute/,
    "must size against the ~20-minute window (the investigation timeout that killed the 2026-10-24 ask)",
  );
  assert.match(agentsMd, /inline/i, "must allow inline attempts for small single-change asks");
  assert.match(
    agentsMd,
    /[Dd]ispatch/,
    "must dispatch large / multi-repo / multi-PR asks instead of attempting inline",
  );
});

test("AGENTS.md routing: dispatch targets the work repos with the agent:ready label (not pizza-eagle)", () => {
  assert.match(
    agentsMd,
    /agent:ready/,
    "dispatch issues must be labeled agent:ready (dd-agent's pickup label)",
  );
  assert.match(
    agentsMd,
    /dd-agent/,
    "dispatch must name dd-agent as the pickup system",
  );
  assert.match(
    agentsMd,
    /never pizza-eagle itself|pizza-eagle itself/,
    "must note the App is not installed on pizza-eagle — dispatch targets the work repos",
  );
});

test("AGENTS.md routing: PII hard rules for public-repo issue bodies are stated as never-violated", () => {
  assert.ok(agentsMd.includes("PII"), "must carry PII hard rules for issue bodies");
  assert.match(
    agentsMd,
    /public|PUBLIC/,
    "must state the repos are public — issue bodies are world-readable",
  );
  // The hard rule's own framing (parallels the Slack masking rules).
  assert.match(
    agentsMd,
    /never violated/i,
    "PII discipline must be framed as a hard rule, never violated",
  );
  // The concrete never-list: raw data, identities, durable-path leaks.
  for (const banned of ["DB rows", "thread-context", "raw bucket paths", "presigned URLs"]) {
    assert.ok(
      agentsMd.includes(banned),
      `PII never-list must ban ${JSON.stringify(banned)} in issue bodies`,
    );
  }
});

test("AGENTS.md routing: status loop is pull-based on mention with gh lookups", () => {
  assert.match(
    agentsMd,
    /[Ss]tatus loop/,
    "must document the status-lookup behavior for dispatched threads",
  );
  assert.match(
    agentsMd,
    /gh issue view/,
    "status loop must use gh issue view for issue state/assignee/linked PR",
  );
  assert.match(
    agentsMd,
    /gh pr (list|view)/,
    "status loop must use gh pr list / gh pr view for checks and review state",
  );
  assert.match(
    agentsMd,
    /pull-based/,
    "status must be pull-based on mention — no polling daemon",
  );
});

test("AGENTS.md scope discipline: multi-part asks are split and dispatched by the eagle, not punted to the human", () => {
  // The 1e7474f language ("re-mention me for [second piece]") must be gone —
  // it turned multi-PR asks into two human round-trips and two timeouts.
  assert.doesNotMatch(
    agentsMd,
    /re-mention/,
    "the old punt-to-human 're-mention me' language must be removed from scope discipline",
  );
  assert.match(
    agentsMd,
    /dispatch each piece/i,
    "scope discipline must say the eagle dispatches each piece itself in one reply",
  );
  assert.match(
    agentsMd,
    /one investigation = one focused change/i,
    "the focused-change rule survives, now scoped to read-only investigations",
  );
});

test("AGENTS.md: inline PR flow is gated by routing (small ~20-min single-repo single-PR only)", () => {
  const prBlock = agentsMd.slice(
    agentsMd.indexOf("Opening PRs"),
    agentsMd.indexOf("## feedflag pipeline"),
  );
  assert.ok(prBlock.length > 0, "Opening PRs block not found");
  assert.match(
    prBlock,
    // Whitespace-tolerant: AGENTS.md wraps prose at ~78 columns.
    /routing section\s+below\s+sized it as an\s+inline attempt/,
    "the PR flow must defer to the routing section — it is no longer the default path for code-change asks",
  );
  assert.match(
    prBlock,
    /never attempted inline/,
    "the PR flow must say larger / multi-repo asks are never attempted inline",
  );
});

test("AGENTS.md: feedflag is declared as our own repo with the ops-vs-development scope split", () => {
  // The 2026-10-24 and 2026-10-26 asks were mis-answered with "feedflag is
  // an external client, we don't have the code for it — ask the owner",
  // even though feedflag is pizza-to-the-polls/feedflag and later runs
  // fixed real feedflag incidents fine (2026-10-30 self-flagging). The gap
  // was orientation, not capability — this test keeps the "our repo" claim
  // and the scope split from regressing out of the copied operator context.
  const section = agentsMd.slice(
    agentsMd.indexOf("## feedflag — our repo"),
    agentsMd.indexOf("## feedflag pipeline"),
  );
  assert.ok(section.length > 0, "the 'feedflag — our repo' section must exist before the pipeline details");
  assert.match(
    section,
    /pizza-to-the-polls\/feedflag/,
    "must name the feedflag repo (the agent answers as if it owns it)",
  );
  assert.match(
    section,
    /our repo\*\*/i,
    "must state feedflag is our repo — not an external client",
  );
  assert.match(
    section,
    /#feed-lines/,
    "must name the channel feedflag posts wait-time/line updates to",
  );
  assert.match(
    section,
    /src\/extract-wait-times\.ts/,
    "must point at the posting logic so investigations start from the code",
  );
  assert.match(
    section,
    /ignoredAuthors/,
    "must mention ignoredAuthors (self-flag prevention lever, 2026-10-30 ask)",
  );
  assert.match(
    section,
    /pizza-eagle-agent/,
    "must say the box can mint pizza-eagle-agent tokens for feedflag under the write gate",
  );
  assert.match(
    section,
    /diagnose\s*\*and\*\s+fix/i,
    "ops questions must be in scope to diagnose AND fix, not just diagnose",
  );
  assert.match(
    section,
    /propose as issues/,
    "classifier/pipeline development must be proposed as issues, not hand-built",
  );
  // The old mis-answer framing must not appear anywhere outside this
  // section (inside it, "not an external client" is the deliberate
  // counter-claim to the 2026-10-24 redirect).
  const beforeSection = agentsMd.slice(0, agentsMd.indexOf("## feedflag — our repo"));
  const afterSection = agentsMd.slice(agentsMd.indexOf("## feedflag pipeline"));
  assert.doesNotMatch(
    beforeSection + afterSection,
    /external client/i,
    "AGENTS.md must never describe feedflag as an external client outside the our-repo section",
  );
});

/**
 * The dispatch skill carries the issue-body template + PII checklist that
 * keep AGENTS.md lean (routing decisions in AGENTS.md, mechanics in the
 * skill). Same frontmatter contract as skills/ga/SKILL.md.
 */
const dispatchSkill = readFileSync(
  join(repoRoot, "skills", "dispatch", "SKILL.md"),
  "utf8",
);

test("skills/dispatch/SKILL.md: frontmatter declares the dispatch skill", () => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(dispatchSkill);
  assert.ok(m, "dispatch skill must have YAML frontmatter like skills/ga/SKILL.md");
  const meta = ((): Record<string, unknown> => {
    try {
      // Minimal parse: the frontmatter is flat `name:` / `description:` keys.
      const out: Record<string, unknown> = {};
      for (const line of m![1].split("\n")) {
        const kv = /^(\w+):\s*(.*)$/.exec(line);
        if (kv) out[kv[1]] = kv[2];
      }
      return out;
    } catch {
      return {};
    }
  })();
  assert.equal(meta["name"], "dispatch", "skill name must be dispatch");
  assert.match(
    String(meta["description"] ?? ""),
    /agent:ready/,
    "skill description must say it creates agent:ready issues for dd-agent pickup",
  );
});

test("skills/dispatch/SKILL.md: carries the dd-agent pickup template, PII checklist, and status lookups", () => {
  for (const section of ["## Context", "## Acceptance criteria", "## Constraints", "## Test expectations"]) {
    assert.ok(
      dispatchSkill.includes(section),
      `issue template must include the ${section} section (dd-agent pickup format)`,
    );
  }
  assert.match(
    dispatchSkill,
    /PII checklist/i,
    "skill must carry the PII checklist run before every issue creation",
  );
  for (const banned of ["DB rows", "thread-context", "raw bucket paths", "presigned URLs", "requester identities"]) {
    assert.ok(
      dispatchSkill.includes(banned),
      `PII checklist must ban ${JSON.stringify(banned)} — repos are public and issue bodies are durable`,
    );
  }
  assert.match(
    dispatchSkill,
    /gh issue create/,
    "skill must show the gh issue create command with the agent:ready label",
  );
  assert.match(
    dispatchSkill,
    /gh issue view/,
    "skill must carry the gh issue view status-lookup command",
  );
  assert.match(
    dispatchSkill,
    /gh-token\.mjs/,
    "skill must mint a scoped token via scripts/gh-token.mjs before dispatching",
  );
});

test("dispatch docs: every agent:ready issue carries the Slack thread deeplink (listener-written header)", () => {
  // Traceability (2026-10-30 ask): issue → originating Slack thread. The
  // listener writes the deeplink as thread-context.md's first line (trusted
  // authenticated metadata); the dispatch skill tells the agent to quote it
  // in the body, and the PII checklist scopes it to channel + timestamp.
  assert.match(
    dispatchSkill,
    /## Slack thread/,
    "issue-body template must have a Slack thread section for the deeplink",
  );
  assert.match(
    dispatchSkill,
    /pizzatothepolls\.slack\.com\/archives\/C1234ABCD\/p1729562400123456/,
    "template must show the deeplink shape (channel + timestamp only)",
  );
  assert.match(
    agentsMd,
    /Slack thread:/,
    "AGENTS.md case context must document the thread-context.md header line",
  );
  // AGENTS.md and the skill must agree the deeplink is the ONE permitted
  // Slack artifact — everything else Slack stays out of public bodies.
  assert.match(
    agentsMd,
    /thread deeplink from `thread-context\.md`'s header[\s\S]*?never member ids or message text/,
    "AGENTS.md PII never-list must carve out exactly the deeplink (channel + timestamp, nothing else)",
  );
});

test("dispatch skill: PII checklist and template agree with the AGENTS.md never-list", () => {
  // The two documents must ban the same things — a checklist narrower than
  // AGENTS.md's hard rule would let a banned item slip through dispatch.
  const agentsNever = agentsMd.slice(
    agentsMd.indexOf("PII discipline for issue bodies"),
    agentsMd.indexOf("masking rules below"),
  );
  assert.ok(agentsNever.length > 0, "AGENTS.md PII never-list not found");
  for (const banned of ["DB rows", "contact info", "requester identities", "thread-context", "raw bucket paths", "presigned URLs"]) {
    assert.ok(
      agentsNever.includes(banned),
      `AGENTS.md never-list must ban ${JSON.stringify(banned)}`,
    );
    assert.ok(
      dispatchSkill.includes(banned),
      `dispatch skill checklist must ban ${JSON.stringify(banned)} (parity with AGENTS.md)`,
    );
  }
});

/**
 * The pizzabase admin API skills (block-people, trusted-reports,
 * partner-users, pizzabase-api) carry the write-gate contract: the key
 * comes from Secrets Manager, writes require writeAllowed + an explicit
 * ask, and the audit fields carry the requester's identity. AGENTS.md's
 * "Pizzabase admin API writes" section must stay in sync with them.
 */
const SKILL_FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const parseFrontmatter = (md: string): Record<string, string> => {
  const m = SKILL_FRONTMATTER_RE.exec(md);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
};
const skill = (name: string) =>
  readFileSync(join(repoRoot, "skills", name, "SKILL.md"), "utf8");

test("pizzabase-api skills: frontmatter + the key comes from Secrets Manager, never the table", () => {
  for (const name of [
    "pizzabase-api",
    "block-people",
    "trusted-reports",
    "partner-users",
  ]) {
    const meta = parseFrontmatter(skill(name));
    assert.equal(meta["name"], name, `${name}: frontmatter name must match dir`);
    assert.match(
      String(meta["description"] ?? ""),
      /pizzabase|ban|trusted|partner/i,
      `${name}: description must describe discovery triggers`,
    );
    assert.match(
      skill(name),
      /ptp\/prod\/pizza-eagle\/pizzabase-api-key/,
      `${name}: must name the Secrets Manager secret`,
    );
    assert.match(
      skill(name),
      /writeAllowed/,
      `${name}: must state the writeAllowed gate`,
    );
  }
});

test("partner-users skill: the users-table contract", () => {
  const md = skill("partner-users");
  // Partner additions need the person's name/org ask, and removal's
  // SET-NULL + session-revocation effects must be spelled out.
  assert.match(md, /partner list/, "must name what the users table is");
  assert.match(md, /POST https:\/\/base\.polls\.pizza\/users/, "must name the add endpoint");
  assert.match(md, /admin.*false/is, "must say partners are admin: false");
  assert.match(md, /ON DELETE SET\s+NULL/, "must state the removal attribution effect");
  assert.match(md, /polls\.pizza\/partners\/report/, "must name the partner login page");
});

test("agent/AGENTS.md: pizzabase API writes section stays in sync with the skills", () => {
  assert.match(agentsMd, /## Pizzabase admin API writes/, "section must exist");
  assert.match(
    agentsMd,
    /ptp\/prod\/pizza-eagle\/pizzabase-api-key/,
    "AGENTS.md must name the secret so the gate is discoverable from both sides",
  );
  // The raw-SQL hard rule must stay untouched — API writes don't reopen it.
  assert.match(agentsMd, /NEVER execute any write against the database/);
  assert.match(agentsMd, /NEVER SELECT from `api_keys`/);
});
