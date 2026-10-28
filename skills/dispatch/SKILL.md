---
name: dispatch
description: Dispatch coding asks that are too large for an inline attempt (over ~20 minutes or multi-repo/multi-PR) as agent:ready GitHub issues for dd-agent pickup. Carries the issue-body template, the PII checklist for public repos, and the status-lookup commands. Use after routing classifies an ask as "dispatch".
---

# Dispatch — agent:ready issue creation

GitHub is the bus between pizza-eagle and dd-agent: dispatching means
creating one GitHub issue per repo/PR, labeled `agent:ready`, in the work
repo dd-agent is pointed at (pizzabase, polls.pizza, hotnready — **not**
pizza-eagle itself; the App is not installed there). dd-agent's daemon
auto-discovers labeled issues and runs its own plan → implement → checks →
review → PR cycle per issue.

## 1. Mint a scoped token (one per repo)

```bash
GH_TOKEN=$(node /opt/pizza-eagle/scripts/gh-token.mjs --repo pizza-to-the-polls/<repo>)
export GH_TOKEN
```

Same minted-token flow as inline PRs — the helper enforces the
`request-auth.json` write gate itself. If the mint refuses with "write
powers not granted", the requester isn't an admin; say so in the thread
and stop. (Dispatch is a write action — investigations never mint tokens.)

## 2. Create the issue

```bash
gh issue create \
  --repo pizza-to-the-polls/<repo> \
  --label agent:ready \
  --title "<descriptive, repo-scoped title>" \
  --body-file /tmp/dispatch-issue-<repo>.md
```

Write the body to a file first (avoids quoting hell) and verify it against
the PII checklist below before running the command.

**If `gh` errors that the `agent:ready` label doesn't exist**, say so in
the thread rather than dispatching unlabeled — dd-agent discovers only
labeled issues.

## 3. Issue body template (dd-agent pickup format)

Condensed from the established triage format (see BACKLOG and existing
`agent:ready` issues on pizzabase for real examples):

```markdown
## Context
{Technical background only. What behavior is wrong / missing, where in the
stack it lives, and how it was observed (log line, metric, report shape) —
no requester identity, no Slack prose, no verbatim thread text.}

## Acceptance criteria
- {One bullet per deliverable, testable in isolation.}
- {Split multi-repo asks so each issue is self-sufficient — no "and also".}

## Constraints
- {Architecture decisions, branch targets, data flow constraints.}
- {e.g. "don't touch .github/workflows/", "draft PR to main", "feature flag behind X".}

## Test expectations
- {What passing looks like: CI checks, a manual verification step, or a
  regression test to add.}
```

Write it like a blog post — a stranger reading the repo should understand
the ask with no Slack context.

## 4. PII checklist — NEVER VIOLATED (verify before creating EVERY issue)

All six org repos are **public**. Issue bodies are world-readable and
durable — they outlive the Slack thread that asked for the work. Before
running `gh issue create`, re-read the drafted body and confirm every box:

- [ ] **No DB rows** — describe the query or the data pattern, never paste
      raw rows. ("Reports created via MMS with no linked upload" — not the
      rows themselves.)
- [ ] **No contact info** — phones masked or omitted, names omitted.
      "an uploader reported" — never "`$name` reported from `+1•••`".
- [ ] **No requester identities** — the issue stands on technical merit;
      no "Scott asked for this", no Slack member ids, no @-handles. The
      de facto author line is "via pizza-eagle dispatch".
- [ ] **No `thread-context.md` verbatim** — summarize only what's relevant
      to the change.
- [ ] **No raw bucket paths** — `raw-prod.polls.pizza/...` never appears;
      use CDN paths (`media.polls.pizza/...`) where a path is needed.
- [ ] **No presigned URLs** — they're credentials; never, in any form.
- [ ] **Polling-place addresses** are public info — fine to reference —
      but never tie one to an individual uploader or reporter.

This parallels and extends the Slack masking rules (mask phones,
PII-light queries by default). If a drafted body fails any box, rewrite
it before dispatch — a PII slip in a public issue is permanent.

## 5. Thread reply after dispatching

One reply per dispatch, all links together:

> Dispatched as `pizzabase#NNN` (+ `polls.pizza#MMM` if split) — agent PRs
> will follow. Ask me for status anytime in this thread.

Split multi-repo asks into one issue per repo and dispatch them all in
one command sequence, then reply once with every issue link.

## 6. Status lookup (pull-based — on mention only)

When asked "any news on this?" in a dispatched thread, run read-only `gh`
lookups and report. No polling daemon — status is pulled on mention.

```bash
# Issue state, assignee, body/title
gh issue view <n> -R pizza-to-the-polls/<repo> --json state,assignee,title

# PRs mentioning this issue
gh pr list -R pizza-to-the-polls/<repo> --state all --json number,state,title,headRefName

# PR detail (checks, reviews, merge state)
gh pr view <n> -R pizza-to-the-polls/<repo> --json state,mergeable,reviews,statusCheckRollup
```

Report per dispatched issue:
- **Issue**: state (open/closed), assignee, linked PR if any.
- **PR** (if present): state, CI checks (pass/fail/pending), review status.
- **"Still in dd-agent's queue"** if the issue is open with no PR yet.
