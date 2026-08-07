-- Stock Imports for Shop - initial schema.
-- Table prefix: stk_
-- Applied once by the Cactus module migration runner during the build step.
-- Hard-depends on the shop module being installed first (it writes to shp_products).
-- Idempotent throughout (fresh installs and re-runs are both safe). Later schema
-- changes ship as a NEW numbered file (002_*.sql, ...) - never edits to this one:
-- the migration ledger records this file as applied, so an edit here would only
-- ever reach fresh installs.

-- ---------------------------------------------------------------------------
-- Single-row settings. One supplier stock feed per shop.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "stk_settings" (
    "id"                  TEXT         NOT NULL DEFAULT 'singleton',
    "csv_url"             TEXT,
    -- Which column of the file carries the product code and which carries the
    -- number. Held as header names, matched case-insensitively, because a
    -- column index breaks the moment the supplier inserts a column.
    "sku_column"          TEXT         NOT NULL DEFAULT 'ProductCode',
    "stock_column"        TEXT         NOT NULL DEFAULT 'FreeStock',
    -- 0 means "only when someone presses the button". Otherwise the number of
    -- hours between automatic runs; the hourly cron is the clock it counts on.
    "frequency_hours"     INTEGER      NOT NULL DEFAULT 24,
    -- What to do with a product whose SKU is not in the file at all. IGNORE
    -- leaves its count exactly as it was; ZERO treats absence as none in stock.
    "missing_behaviour"   TEXT         NOT NULL DEFAULT 'IGNORE',
    -- Whether a matched product should also have inventory tracking switched on.
    -- Without it the shop stores the count but never enforces it.
    "enable_tracking"     BOOLEAN      NOT NULL DEFAULT true,
    -- Basic auth for feeds behind a username/password (encrypted at rest).
    "auth_user"           TEXT,
    "auth_password_encrypted" TEXT,
    "last_run_at"         TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stk_settings_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "stk_settings"
        ADD CONSTRAINT "stk_settings_missing_behaviour_check"
        CHECK ("missing_behaviour" IN ('IGNORE', 'ZERO'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "stk_settings"
        ADD CONSTRAINT "stk_settings_frequency_hours_check"
        CHECK ("frequency_hours" >= 0 AND "frequency_hours" <= 168);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "stk_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- The run in progress. One row at most: a stock refresh that gets cut short by
-- the sixty-second route ceiling has to be resumable, so the outstanding
-- (sku, count) pairs are parked here and applied a batch at a time.
--
-- "lease_until" is what stops the button and the cron shoving each other: a run
-- holds the lease while it works, and anything else that arrives sees a live
-- lease and stands down rather than starting a second copy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "stk_import_job" (
    "id"             TEXT         NOT NULL DEFAULT 'singleton',
    "status"         TEXT         NOT NULL,
    "trigger"        TEXT         NOT NULL,
    -- Outstanding updates as [["SKU", 12], ...]. Emptied as batches land.
    "pending"        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "rows_in_file"   INTEGER      NOT NULL DEFAULT 0,
    "matched"        INTEGER      NOT NULL DEFAULT 0,
    "changed"        INTEGER      NOT NULL DEFAULT 0,
    "applied"        INTEGER      NOT NULL DEFAULT 0,
    "unmatched"      INTEGER      NOT NULL DEFAULT 0,
    "missing"        INTEGER      NOT NULL DEFAULT 0,
    "zeroed"         INTEGER      NOT NULL DEFAULT 0,
    -- Stock cells that were not a number, kept as text examples for the report.
    "bad_values"     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "error"          TEXT,
    "lease_until"    TIMESTAMP(3),
    "run_by"         TEXT,                         -- admin user id, no FK (core table)
    "started_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"    TIMESTAMP(3),
    CONSTRAINT "stk_import_job_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "stk_import_job"
        ADD CONSTRAINT "stk_import_job_status_check"
        CHECK ("status" IN ('FETCHING', 'APPLYING', 'COMPLETED', 'FAILED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "stk_import_job"
        ADD CONSTRAINT "stk_import_job_trigger_check"
        CHECK ("trigger" IN ('MANUAL', 'CRON'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Audit trail. One row per finished run, so the owner can see at a glance
-- whether the supplier's file has quietly stopped arriving.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "stk_import_log" (
    "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "trigger"        TEXT         NOT NULL,
    "status"         TEXT         NOT NULL,
    "rows_in_file"   INTEGER      NOT NULL DEFAULT 0,
    "matched"        INTEGER      NOT NULL DEFAULT 0,
    "updated_count"  INTEGER      NOT NULL DEFAULT 0,
    "unmatched"      INTEGER      NOT NULL DEFAULT 0,
    "missing"        INTEGER      NOT NULL DEFAULT 0,
    "zeroed"         INTEGER      NOT NULL DEFAULT 0,
    "duration_ms"    INTEGER,
    "error"          TEXT,
    "run_by"         TEXT,                         -- admin user id, no FK (core table)
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stk_import_log_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "stk_import_log"
        ADD CONSTRAINT "stk_import_log_status_check"
        CHECK ("status" IN ('COMPLETED', 'FAILED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "stk_import_log"
        ADD CONSTRAINT "stk_import_log_trigger_check"
        CHECK ("trigger" IN ('MANUAL', 'CRON'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "stk_import_log_created_at_idx" ON "stk_import_log" ("created_at" DESC);
