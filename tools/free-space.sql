-- Run this in the Neon SQL editor when the project reports "exceeded the quota".
--
-- `scans` stores the WHOLE universe as JSONB, one row per chain per scan, and
-- nothing ever deleted one. Nothing reads an old one either: the engine and the
-- dashboard both want the NEWEST per chain. The archive was pure cost.

-- 1. See where the space went, before deleting anything.
SELECT relname AS tabla, pg_size_pretty(pg_total_relation_size(relid)) AS peso
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- 2. How many scans are stored, and how many are actually needed (one per chain).
SELECT chain, count(*) AS filas, pg_size_pretty(sum(pg_column_size(snapshots))) AS peso
FROM scans GROUP BY chain;

-- 3. Keep only the newest scan of each chain. This is what the fix now does
--    automatically on every save; this statement cleans up what accumulated.
DELETE FROM scans s
WHERE s.scanned_at < (SELECT max(t.scanned_at) FROM scans t WHERE t.chain = s.chain);

-- 4. Return the freed pages to the operating system. A plain DELETE only marks
--    them reusable by Postgres, which does not help a storage quota.
VACUUM FULL scans;

-- 5. Confirm.
SELECT chain, count(*) AS filas FROM scans GROUP BY chain;
