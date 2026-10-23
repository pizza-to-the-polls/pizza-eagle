---
name: ga
description: Query Google Analytics 4 for polls.pizza traffic — visitors, realtime activity, sources, pages. Use when asked about site traffic, visitor counts, "how many people are on the site", traffic spikes, referral sources, or election-day live activity. Property ID 375041192.
---

# Google Analytics 4 — polls.pizza

All queries go through the zero-dep helper in the pizza-eagle repo:

    node /opt/pizza-eagle/scripts/ga.mjs <command> [flags]

The property comes from `GA_PROPERTY_ID` in the environment (value: **375041192**). Read-only service account; aggregate data only — no PII, no masking needed.

## Commands
- `report` — historical: `--start 7d|YYYY-MM-DD|today --end today`, repeatable `--dim`/`--metric`, `--filter name=value` (comma values = in-list), `--limit N`
- `realtime` — active users right now (same flags, no dates)
- `accounts` — property discovery; usually unnecessary (property is known)

## Recipes
- Visitors last week: `report --dim date --metric totalUsers --metric sessions --start 7d`
- Where visitors are: `report --dim country --dim city --metric totalUsers --start 7d --limit 10`
- Top pages: `report --dim pagePath --metric screenPageViews --start 7d --limit 15`
- Right now: `realtime --dim country --dim city --metric activeUsers`
- Referral sources: `report --dim sessionSource --metric sessions --start 30d --limit 10`

## Conventions
- Report the metric you used: `totalUsers` = visitors, `sessions` = visits, `screenPageViews` = page loads.
- Always state the date range with the number.
- Election-day live questions ("is traffic spiking from TX right now?") → `realtime` with city/country dimensions.
- GA4 dates come back as `YYYYMMDD` — reformat for humans.
