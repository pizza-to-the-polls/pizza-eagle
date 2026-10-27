-- 2026-10-27 red-team remediation, finding 1 — run by a HUMAN via the master
-- credential path (pizza-psql). ptp_ro is SELECT-only BY DESIGN and cannot
-- revoke from itself; this file is the exact SQL for an admin to run.
--
-- Context: pizza-eagle investigations authenticate to the pizzabase cluster
-- as ptp_ro. That role had SELECT on ALL tables — including two that hold
-- usable credentials:
--
--   api_keys.key            — Pizzabase API keys, accepted by the API's own
--                              auth (src/controller/helper.ts) for WRITE
--                              endpoints (create/cancel orders, etc.).
--   integration_sessions.credentials — social-platform OAuth tokens
--                              (bluesky, threads, ...) as a JSON map.
--
-- A "read-only" SELECT against either table IS a credential grab: the chain
-- SELECT → key → authenticated API mutation bypasses every SQL write guard.
--
-- Run as a superuser/master role (NOT ptp_ro):
--
--   psql "$(…master connstring…)" -f sql/revoke-credential-tables.sql
--
-- Then verify as ptp_ro (RDS Data API):
--   SELECT has_table_privilege('ptp_ro', 'public.api_keys', 'SELECT') AS api_keys,
--          has_table_privilege('ptp_ro', 'public.integration_sessions', 'SELECT') AS integration_sessions;
--   -- both must be false.

BEGIN;

REVOKE SELECT ON TABLE public.api_keys FROM ptp_ro;
REVOKE SELECT ON TABLE public.integration_sessions FROM ptp_ro;

-- Future migrations create tables with default privileges; nothing new is
-- granted to ptp_ro automatically (default grants come from the master
-- role, not ptp_ro). After running this, an admin should re-check every
-- table ptp_ro can still reach — this verification query prints anything
-- that remains (must return 0 rows for the two credential tables):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'ptp_ro'
--     AND table_schema = 'public'
--     AND table_name IN ('api_keys', 'integration_sessions');

COMMIT;