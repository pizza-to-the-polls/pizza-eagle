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
