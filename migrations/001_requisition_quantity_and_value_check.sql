-- Migration 001 — adds the quantity + "best value" confirmation to requisitions.
--
-- schema.sql uses CREATE TABLE IF NOT EXISTS, so it will NOT add columns to a
-- database that already has the requisitions table. Run this ONCE against any
-- database created before these columns existed:
--
--   npm run db:migrate:local
--   npm run db:migrate:remote
--
-- Running it a second time fails with "duplicate column name" — that error is
-- harmless and simply means the migration has already been applied.
--
-- cost_pence becomes the price of ONE unit. Existing rows get quantity = 1, so
-- their totals (cost_pence * quantity) are unchanged.
ALTER TABLE requisitions ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

-- 0 for everything filed before the confirmation existed; the form now requires
-- it, so anything submitted from here on is 1.
ALTER TABLE requisitions ADD COLUMN value_checked INTEGER NOT NULL DEFAULT 0;
