import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import type {
  StkJobStatus,
  StkJobStatusPayload,
  StkLogEntry,
  StkSettings,
  StkSettingsPatch,
  StkTrigger,
} from '@/modules/stock-import-for-shop/lib/types'

// Both tables hold exactly one row, keyed on a fixed id, so a second run can
// never quietly appear alongside the first.
const SINGLETON = 'singleton'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS: StkSettings = {
  csvUrl: null,
  skuColumn: 'ProductCode',
  stockColumn: 'FreeStock',
  frequencyHours: 24,
  missingBehaviour: 'IGNORE',
  enableTracking: true,
  authUser: null,
  hasAuthPassword: false,
  lastRunAt: null,
}

function mapSettings(row: Record<string, unknown>): StkSettings {
  return {
    csvUrl: (row.csv_url as string | null) ?? null,
    skuColumn: (row.sku_column as string | null) || DEFAULTS.skuColumn,
    stockColumn: (row.stock_column as string | null) || DEFAULTS.stockColumn,
    frequencyHours: Number(row.frequency_hours ?? DEFAULTS.frequencyHours),
    missingBehaviour: row.missing_behaviour === 'ZERO' ? 'ZERO' : 'IGNORE',
    enableTracking: row.enable_tracking !== false,
    authUser: (row.auth_user as string | null) ?? null,
    hasAuthPassword: !!row.auth_password_encrypted,
    lastRunAt: (row.last_run_at as Date | null)?.toISOString() ?? null,
  }
}

export async function getSettings(): Promise<StkSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "stk_settings" WHERE "id" = ${SINGLETON} LIMIT 1
  `
  const row = rows[0]
  return row ? mapSettings(row) : { ...DEFAULTS }
}

/** The plaintext feed credentials, decrypted. Server-side callers only. */
export async function getFeedAuth(): Promise<{ user: string; password: string } | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "auth_user", "auth_password_encrypted" FROM "stk_settings" WHERE "id" = ${SINGLETON} LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  const user = (row.auth_user as string | null) ?? ''
  const password = tryDecryptSecret(row.auth_password_encrypted as string | null) ?? ''
  if (!user && !password) return null
  return { user, password }
}

export async function updateSettings(patch: StkSettingsPatch): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "stk_settings" ("id") VALUES (${SINGLETON}) ON CONFLICT ("id") DO NOTHING
  `
  // The password is three-valued: absent means leave it, null means clear it,
  // a string means replace it. COALESCE cannot express "clear", so it is set
  // by its own statement only when the caller actually said something about it.
  await prisma.$executeRaw`
    UPDATE "stk_settings" SET
      "csv_url"           = COALESCE(${patch.csvUrl ?? null}::text, "csv_url"),
      "sku_column"        = COALESCE(${patch.skuColumn ?? null}::text, "sku_column"),
      "stock_column"      = COALESCE(${patch.stockColumn ?? null}::text, "stock_column"),
      "frequency_hours"   = COALESCE(${patch.frequencyHours ?? null}::integer, "frequency_hours"),
      "missing_behaviour" = COALESCE(${patch.missingBehaviour ?? null}::text, "missing_behaviour"),
      "enable_tracking"   = COALESCE(${patch.enableTracking ?? null}::boolean, "enable_tracking"),
      "updated_at"        = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
  // csvUrl and authUser are clearable in the same way - an empty string from the
  // form means "there isn't one", and COALESCE would have kept the old value.
  if (patch.csvUrl !== undefined) {
    const value = patch.csvUrl?.trim() ? patch.csvUrl.trim() : null
    await prisma.$executeRaw`UPDATE "stk_settings" SET "csv_url" = ${value} WHERE "id" = ${SINGLETON}`
  }
  if (patch.authUser !== undefined) {
    const value = patch.authUser?.trim() ? patch.authUser.trim() : null
    await prisma.$executeRaw`UPDATE "stk_settings" SET "auth_user" = ${value} WHERE "id" = ${SINGLETON}`
  }
  if (patch.authPassword !== undefined) {
    const value = patch.authPassword ? encryptSecret(patch.authPassword) : null
    await prisma.$executeRaw`UPDATE "stk_settings" SET "auth_password_encrypted" = ${value} WHERE "id" = ${SINGLETON}`
  }
}

export async function markRunStarted(when: Date): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "stk_settings" ("id") VALUES (${SINGLETON}) ON CONFLICT ("id") DO NOTHING
  `
  await prisma.$executeRaw`
    UPDATE "stk_settings" SET "last_run_at" = ${when}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${SINGLETON}
  `
}

// ---------------------------------------------------------------------------
// The run in progress
// ---------------------------------------------------------------------------

/** How long a step may hold the job before another caller may take it over. */
export const LEASE_MS = 90_000

export type StkJobRow = {
  status: StkJobStatus
  trigger: StkTrigger
  pending: [string, number][]
  rowsInFile: number
  matched: number
  changed: number
  applied: number
  unmatched: number
  missing: number
  zeroed: number
  badValues: string[]
  error: string | null
  leaseUntil: Date | null
  runBy: string | null
  startedAt: Date
  finishedAt: Date | null
}

function mapJob(row: Record<string, unknown>): StkJobRow {
  // jsonb comes back already parsed. Anything that is not the array we wrote is
  // treated as nothing left to do rather than crashing a background run.
  const pending = Array.isArray(row.pending) ? (row.pending as [string, number][]) : []
  return {
    status: row.status as StkJobStatus,
    trigger: row.trigger as StkTrigger,
    pending,
    rowsInFile: Number(row.rows_in_file ?? 0),
    matched: Number(row.matched ?? 0),
    changed: Number(row.changed ?? 0),
    applied: Number(row.applied ?? 0),
    unmatched: Number(row.unmatched ?? 0),
    missing: Number(row.missing ?? 0),
    zeroed: Number(row.zeroed ?? 0),
    badValues: Array.isArray(row.bad_values) ? (row.bad_values as string[]) : [],
    error: (row.error as string | null) ?? null,
    leaseUntil: (row.lease_until as Date | null) ?? null,
    runBy: (row.run_by as string | null) ?? null,
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
  }
}

export async function getJob(): Promise<StkJobRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "stk_import_job" WHERE "id" = ${SINGLETON} LIMIT 1
  `
  return rows[0] ? mapJob(rows[0]) : null
}

/** The job without its pending list - the status poll does not need 400KB of it. */
export async function getJobStatus(): Promise<StkJobStatusPayload | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "status", "trigger", "rows_in_file", "matched", "changed", "applied",
           "unmatched", "missing", "zeroed", "bad_values", "error", "started_at",
           "finished_at", jsonb_array_length("pending") AS "remaining"
    FROM "stk_import_job" WHERE "id" = ${SINGLETON} LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  const status = row.status as StkJobStatus
  return {
    status,
    trigger: row.trigger as StkTrigger,
    rowsInFile: Number(row.rows_in_file ?? 0),
    matched: Number(row.matched ?? 0),
    changed: Number(row.changed ?? 0),
    applied: Number(row.applied ?? 0),
    unmatched: Number(row.unmatched ?? 0),
    missing: Number(row.missing ?? 0),
    zeroed: Number(row.zeroed ?? 0),
    badValues: Array.isArray(row.bad_values) ? (row.bad_values as string[]) : [],
    remaining: Number(row.remaining ?? 0),
    error: (row.error as string | null) ?? null,
    startedAt: (row.started_at as Date).toISOString(),
    finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
    done: status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED',
  }
}

/**
 * Claims the job slot for a new run, or refuses because one is genuinely still
 * going. "Still going" means an unfinished job whose lease has not expired - an
 * abandoned run (the route died mid-step) releases itself after LEASE_MS rather
 * than blocking the button forever.
 *
 * The INSERT ... ON CONFLICT DO UPDATE ... WHERE is the whole point: two callers
 * racing both run this statement, and Postgres lets exactly one of them past.
 */
export async function claimJob(trigger: StkTrigger, runBy: string | null): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    INSERT INTO "stk_import_job"
      ("id", "status", "trigger", "pending", "rows_in_file", "matched", "changed",
       "applied", "unmatched", "missing", "error", "lease_until", "run_by",
       "started_at", "updated_at", "finished_at")
    VALUES
      (${SINGLETON}, 'FETCHING', ${trigger}, '[]'::jsonb, 0, 0, 0, 0, 0, 0, NULL,
       CURRENT_TIMESTAMP + make_interval(secs => ${LEASE_MS / 1000}), ${runBy},
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT ("id") DO UPDATE SET
      "status"       = 'FETCHING',
      "trigger"      = ${trigger},
      "pending"      = '[]'::jsonb,
      "rows_in_file" = 0,
      "matched"      = 0,
      "changed"      = 0,
      "applied"      = 0,
      "unmatched"    = 0,
      "missing"      = 0,
      "zeroed"       = 0,
      "bad_values"   = '[]'::jsonb,
      "error"        = NULL,
      "lease_until"  = CURRENT_TIMESTAMP + make_interval(secs => ${LEASE_MS / 1000}),
      "run_by"       = ${runBy},
      "started_at"   = CURRENT_TIMESTAMP,
      "updated_at"   = CURRENT_TIMESTAMP,
      "finished_at"  = NULL
    WHERE "stk_import_job"."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
       OR "stk_import_job"."lease_until" IS NULL
       OR "stk_import_job"."lease_until" < CURRENT_TIMESTAMP
  `
  return claimed > 0
}

/**
 * Takes the lease for the next batch of an existing run. Same race guard as
 * claimJob: only one caller gets it, so the cron and an impatient button press
 * cannot apply the same batch twice.
 */
export async function leaseJob(): Promise<StkJobRow | null> {
  const taken = await prisma.$executeRaw`
    UPDATE "stk_import_job" SET
      "lease_until" = CURRENT_TIMESTAMP + make_interval(secs => ${LEASE_MS / 1000}),
      "updated_at"  = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
      AND "status" IN ('FETCHING', 'APPLYING')
      AND ("lease_until" IS NULL OR "lease_until" < CURRENT_TIMESTAMP)
  `
  if (taken === 0) return null
  return getJob()
}

export async function saveFetchResult(fields: {
  pending: [string, number][]
  rowsInFile: number
  matched: number
  changed: number
  unmatched: number
  missing: number
  zeroed: number
  badValues: string[]
}): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "stk_import_job" SET
      "status"       = 'APPLYING',
      "pending"      = ${JSON.stringify(fields.pending)}::jsonb,
      "rows_in_file" = ${fields.rowsInFile},
      "matched"      = ${fields.matched},
      "changed"      = ${fields.changed},
      "unmatched"    = ${fields.unmatched},
      "missing"      = ${fields.missing},
      "zeroed"       = ${fields.zeroed},
      "bad_values"   = ${JSON.stringify(fields.badValues)}::jsonb,
      "updated_at"   = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function saveBatchProgress(remaining: [string, number][], appliedDelta: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "stk_import_job" SET
      "pending"    = ${JSON.stringify(remaining)}::jsonb,
      "applied"    = "applied" + ${appliedDelta},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

export async function finishJob(status: 'COMPLETED' | 'FAILED' | 'CANCELLED', error?: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "stk_import_job" SET
      "status"      = ${status},
      "error"       = ${error ?? null},
      "pending"     = '[]'::jsonb,
      "lease_until" = NULL,
      "updated_at"  = CURRENT_TIMESTAMP,
      "finished_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON}
  `
}

/** Hands the lease back so the next cron tick (or button press) can carry on. */
export async function releaseLease(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "stk_import_job" SET "lease_until" = NULL, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${SINGLETON} AND "status" IN ('FETCHING', 'APPLYING')
  `
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function writeLog(entry: {
  trigger: StkTrigger
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED'
  rowsInFile: number
  matched: number
  updatedCount: number
  unmatched: number
  missing: number
  zeroed: number
  durationMs: number | null
  error: string | null
  runBy: string | null
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "stk_import_log"
      ("trigger", "status", "rows_in_file", "matched", "updated_count", "unmatched",
       "missing", "zeroed", "duration_ms", "error", "run_by")
    VALUES
      (${entry.trigger}, ${entry.status}, ${entry.rowsInFile}, ${entry.matched},
       ${entry.updatedCount}, ${entry.unmatched}, ${entry.missing}, ${entry.zeroed},
       ${entry.durationMs}, ${entry.error}, ${entry.runBy})
  `
  // Keep the log to a readable length. A stock feed runs hourly; nobody wants
  // to scroll through a year of it, and nobody wants it growing forever either.
  await prisma.$executeRaw`
    DELETE FROM "stk_import_log"
    WHERE "id" NOT IN (SELECT "id" FROM "stk_import_log" ORDER BY "created_at" DESC LIMIT 50)
  `
}

export async function listLog(limit = 20): Promise<StkLogEntry[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "stk_import_log" ORDER BY "created_at" DESC LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id as string,
    trigger: r.trigger as StkTrigger,
    status: r.status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
    rowsInFile: Number(r.rows_in_file ?? 0),
    matched: Number(r.matched ?? 0),
    updatedCount: Number(r.updated_count ?? 0),
    unmatched: Number(r.unmatched ?? 0),
    missing: Number(r.missing ?? 0),
    zeroed: Number(r.zeroed ?? 0),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    error: (r.error as string | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// The shop side
// ---------------------------------------------------------------------------

/** One product's SKU exactly as stored, with what the shop believes about it. */
export type ShopSku = { sku: string; stock: number | null; tracked: boolean; physical: boolean }

/**
 * Every product that carries a SKU, with the stock count it has now. All three
 * are needed: the SKU to match the file against, the count to work out which
 * rows actually changed, and the tracking flag so switching enforcement on
 * later reaches products whose numbers happen not to have moved. Writing all
 * twenty thousand rows every hour when three of them moved is a lot of database
 * churn for nothing.
 */
export async function getSkuStock(): Promise<ShopSku[]> {
  const rows = await prisma.$queryRaw<
    { sku: string; stock_count: number | null; track_inventory: boolean; type: string }[]
  >`
    SELECT "sku", "stock_count", "track_inventory", "type"
    FROM "shp_products" WHERE "sku" IS NOT NULL AND btrim("sku") <> ''
  `
  return rows.map((row) => ({
    sku: row.sku,
    stock: row.stock_count === null ? null : Number(row.stock_count),
    tracked: row.track_inventory === true,
    physical: row.type === 'PHYSICAL',
  }))
}

/**
 * Applies one batch of (SKU, count) pairs in a single statement.
 *
 * The SKUs here are the ones read back out of shp_products, verbatim - the
 * case-insensitive matching against the supplier's spelling already happened in
 * the diff. So this compares SKU to SKU exactly, which is both unambiguous and
 * able to use the unique index rather than scanning the table once per batch.
 *
 * `enableTracking` additionally switches the shop's own inventory enforcement
 * on for the rows it touches. Without it the count is recorded and then ignored
 * at the checkout, which is the sort of thing an owner only finds out about
 * after overselling something.
 */
export async function applyStockBatch(batch: [string, number][], enableTracking: boolean): Promise<number> {
  if (batch.length === 0) return 0
  const values = Prisma.join(batch.map(([sku, qty]) => Prisma.sql`(${sku}::text, ${qty}::integer)`))

  // Inventory is a physical-goods idea in the shop schema, so enforcement is
  // only switched on for physical products. The count itself is still written
  // wherever the SKU matches - it is the supplier's figure either way.
  const trackingClause = enableTracking
    ? Prisma.sql`, "track_inventory" = CASE WHEN p."type" = 'PHYSICAL' THEN true ELSE p."track_inventory" END`
    : Prisma.empty

  // Without the tracking flip, a row whose count already agrees has nothing to
  // do. With it, a row that agrees may still need tracking switching on - so
  // the guard has to widen, or turning the setting on later would only reach
  // products that happened to move that day.
  const changedClause = enableTracking
    ? Prisma.sql`AND (p."stock_count" IS DISTINCT FROM v."qty" OR (p."type" = 'PHYSICAL' AND NOT p."track_inventory"))`
    : Prisma.sql`AND p."stock_count" IS DISTINCT FROM v."qty"`

  return prisma.$executeRaw`
    UPDATE "shp_products" AS p SET
      "stock_count" = v."qty"${trackingClause},
      -- Restocking has to clear the low-stock dedupe marker, or the next dip
      -- below the threshold never alerts.
      "low_stock_alerted_at" = CASE
        WHEN p."low_stock_threshold" IS NOT NULL AND v."qty" > p."low_stock_threshold" THEN NULL
        ELSE p."low_stock_alerted_at"
      END,
      "updated_at" = CURRENT_TIMESTAMP
    FROM (VALUES ${values}) AS v("sku", "qty")
    WHERE p."sku" = v."sku"
      ${changedClause}
  `
}
