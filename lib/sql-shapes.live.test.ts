import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  connectionUri,
  createTestDatabase,
  createTestRole,
  dropStaleTestObjects,
  dropTestDatabase,
  dropTestRole,
  vpsConfigFromEnv,
  type TestRole,
  type VpsConfig,
} from '@/lib/backup/vps-database'

// Every statement this module writes is raw SQL, and raw SQL is exactly what
// `tsc` and `eslint` have nothing whatsoever to say about. A typo in the
// claim-the-job upsert or in the batch UPDATE would sail through both and only
// surface the first time an owner pressed the button on a live catalogue.
//
// So: provision a throwaway database on the same OVH box the backup round-trip
// uses, apply the module's own migration to it, and run the real statements
// against real rows. Gated on the same credentials the round-trip needs, and
// bound to the same `cactus_rt_` prefix that is the only thing this file may
// ever create or drop.
//
//   RUN_STK_SQL=1 npx vitest run modules/stock-import-for-shop/lib/sql-shapes.live.test.ts

const enabled = process.env.RUN_STK_SQL === '1'
const suite = enabled ? describe : describe.skip

const LEASE_MS = 90_000
const stamp = process.env.STK_SQL_STAMP ?? 'x'
const dbName = `cactus_rt_stk_${stamp}`
const roleName = `cactus_rt_role_stk_${stamp}`

suite('the raw SQL this module ships, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let client: Client

  beforeAll(async () => {
    cfg = vpsConfigFromEnv()
    await dropStaleTestObjects(cfg)
    role = await createTestRole(cfg, roleName)
    await createTestDatabase(cfg, dbName, role)
    // The box's certificate names db.dwoffice.furniture, not the VPS hostname
    // OVH_SERVER carries, and recent `pg` treats sslmode=require as verify-full.
    // The connection is still encrypted; the name check is dropped because this
    // is a scratch database created seconds ago on a host reached by SSH with
    // credentials from .env - there is nothing here to man-in-the-middle.
    client = new Client({
      connectionString: connectionUri(cfg, dbName, role).replace('?sslmode=require', ''),
      ssl: { rejectUnauthorized: false },
    })
    await client.connect()

    // The single shp_products column set these statements actually touch. The
    // shop module's own migration is not this module's to run.
    await client.query(`
      CREATE TABLE "shp_products" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "sku" TEXT UNIQUE,
        "name" TEXT NOT NULL DEFAULT '',
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "catalogue_hidden" BOOLEAN NOT NULL DEFAULT false,
        "type" TEXT NOT NULL DEFAULT 'PHYSICAL',
        "stock_count" INTEGER,
        "track_inventory" BOOLEAN NOT NULL DEFAULT false,
        "low_stock_threshold" INTEGER,
        "low_stock_alerted_at" TIMESTAMP(3),
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    const migration = readFileSync(
      join(process.cwd(), 'modules/stock-import-for-shop/migrations/001_initial.sql'),
      'utf8'
    )
    await client.query(migration)
  }, 180_000)

  afterAll(async () => {
    await client?.end().catch(() => {})
    if (!cfg) return
    await dropTestDatabase(cfg, dbName).catch(() => {})
    await dropTestRole(cfg, roleName).catch(() => {})
  }, 120_000)

  it('applies the migration twice without complaint', async () => {
    const migration = readFileSync(
      join(process.cwd(), 'modules/stock-import-for-shop/migrations/001_initial.sql'),
      'utf8'
    )
    await expect(client.query(migration)).resolves.toBeTruthy()
    const rows = await client.query(`SELECT count(*)::int AS c FROM "stk_settings"`)
    expect(rows.rows[0].c).toBe(1)
  })

  it('claims the job slot exactly once when two callers race', async () => {
    const claim = (trigger: string) =>
      client.query(claimSql, [trigger, null]).then((r) => r.rowCount ?? 0)

    await client.query(`DELETE FROM "stk_import_job"`)
    const first = await claim('MANUAL')
    const second = await claim('CRON')
    expect(first).toBe(1)
    expect(second).toBe(0)

    // A finished run frees the slot.
    await client.query(`UPDATE "stk_import_job" SET "status" = 'COMPLETED', "lease_until" = NULL`)
    expect(await claim('CRON')).toBe(1)

    // So does an expired lease, which is what stops a dead request wedging it.
    await client.query(
      `UPDATE "stk_import_job" SET "status" = 'APPLYING', "lease_until" = CURRENT_TIMESTAMP - interval '1 minute'`
    )
    expect(await claim('MANUAL')).toBe(1)
  })

  it('takes the step lease only when it is free', async () => {
    await client.query(
      `UPDATE "stk_import_job" SET "status" = 'APPLYING', "lease_until" = CURRENT_TIMESTAMP + interval '5 minutes'`
    )
    expect((await client.query(leaseSql)).rowCount).toBe(0)
    await client.query(`UPDATE "stk_import_job" SET "lease_until" = NULL`)
    expect((await client.query(leaseSql)).rowCount).toBe(1)
  })

  it('writes a batch, and only where something actually differs', async () => {
    await client.query(`DELETE FROM "shp_products"`)
    await client.query(`
      INSERT INTO "shp_products" ("sku", "stock_count", "track_inventory", "low_stock_threshold", "low_stock_alerted_at", "type")
      VALUES
        ('AC1', 5, true, NULL, NULL, 'PHYSICAL'),
        ('AC2', 7, true, NULL, NULL, 'PHYSICAL'),
        ('AC3', 0, true, 4, CURRENT_TIMESTAMP, 'PHYSICAL')
    `)

    // AC1 moves, AC2 already agrees, AC3 is restocked past its threshold.
    const written = await client.query(batchSql(false, 3), ['AC1', 9, 'AC2', 7, 'AC3', 20])
    expect(written.rowCount).toBe(2)

    const rows = await client.query(
      `SELECT "sku", "stock_count", "low_stock_alerted_at" FROM "shp_products" ORDER BY "sku"`
    )
    expect(rows.rows.map((r) => [r.sku, r.stock_count])).toEqual([
      ['AC1', 9],
      ['AC2', 7],
      ['AC3', 20],
    ])
    // Restocking above the threshold has to re-arm shop's low-stock alert.
    expect(rows.rows[2].low_stock_alerted_at).toBeNull()
  })

  it('switches tracking on for physical products only, even when the count already agrees', async () => {
    await client.query(`DELETE FROM "shp_products"`)
    await client.query(`
      INSERT INTO "shp_products" ("sku", "stock_count", "track_inventory", "type")
      VALUES ('AC1', 5, false, 'PHYSICAL'), ('DL1', 5, false, 'DIGITAL')
    `)

    const written = await client.query(batchSql(true, 2), ['AC1', 5, 'DL1', 5])
    expect(written.rowCount).toBe(1)

    const rows = await client.query(`SELECT "sku", "track_inventory" FROM "shp_products" ORDER BY "sku"`)
    expect(rows.rows).toEqual([
      { sku: 'AC1', track_inventory: true },
      { sku: 'DL1', track_inventory: false },
    ])

    // Second pass: nothing left to do, so nothing is written.
    expect((await client.query(batchSql(true, 2), ['AC1', 5, 'DL1', 5])).rowCount).toBe(0)
  })

  it('reports how much of the pending list is left without reading the list', async () => {
    await client.query(
      `UPDATE "stk_import_job" SET "pending" = '[["AC1",3],["AC2",4]]'::jsonb WHERE "id" = 'singleton'`
    )
    const rows = await client.query(
      `SELECT jsonb_array_length("pending") AS "remaining" FROM "stk_import_job" WHERE "id" = 'singleton'`
    )
    expect(Number(rows.rows[0].remaining)).toBe(2)
  })

  // The not-in-the-file list. Its query joins a table belonging to a module
  // that may not be installed, and passes twenty thousand SKUs as one jsonb
  // parameter rather than twenty thousand placeholders - two things that are
  // either right or a 500 on a live catalogue, with nothing in between.
  describe('the products a file does not mention', () => {
    beforeAll(async () => {
      await client.query(`DROP TABLE IF EXISTS "svr_variants"`)
      await client.query(`DELETE FROM "shp_products"`)
      await client.query(`
        INSERT INTO "shp_products" ("id", "sku", "name", "status", "catalogue_hidden", "stock_count", "track_inventory")
        VALUES
          ('parent1', 'ZH000',   'Zure Headrest',                  'ACTIVE',   false, NULL, false),
          ('child1',  'AC000012','Zure Headrest - White Mesh',     'ACTIVE',   true,  28,   true),
          ('child2',  'AC000013','Zure Headrest - White Elastomer','DRAFT',    true,  0,    true),
          ('lone1',   'D0001',   'Air Desk 1600',                  'ARCHIVED', false, 4,    false)
      `)
    })

    it('names them, with the listing each variation belongs to', async () => {
      await client.query(`
        CREATE TABLE "svr_variants" (
          "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "product_id" TEXT NOT NULL,
          "child_product_id" TEXT NOT NULL UNIQUE
        )
      `)
      await client.query(`
        INSERT INTO "svr_variants" ("product_id", "child_product_id")
        VALUES ('parent1', 'child1'), ('parent1', 'child2')
      `)

      const present = await client.query(`SELECT to_regclass('svr_variants')::text AS "present"`)
      expect(present.rows[0].present).toBe('svr_variants')

      const rows = await client.query(missingSql(true, null), [
        JSON.stringify(['AC000012', 'AC000013', 'D0001']),
      ])
      // Variations sort under their listing and then by their own name, so
      // Elastomer precedes Mesh; a product that is a listing itself sorts in
      // among them by its own name, which puts the Air Desk first.
      expect(rows.rows.map((r) => [r.sku, r.parent_name])).toEqual([
        ['D0001', null],
        ['AC000013', 'Zure Headrest'],
        ['AC000012', 'Zure Headrest'],
      ])
      expect(rows.rows[1].catalogue_hidden).toBe(true)
      expect(rows.rows[0].status).toBe('ARCHIVED')
    })

    it('honours the display cap', async () => {
      const rows = await client.query(missingSql(true, 2), [
        JSON.stringify(['AC000012', 'AC000013', 'D0001']),
      ])
      expect(rows.rowCount).toBe(2)
    })

    it('matches the shop spelling exactly, not case-insensitively', async () => {
      // The normalisation lives in JS, once. If this query started matching
      // loosely there would be two definitions of "the same code" free to drift.
      const rows = await client.query(missingSql(true, null), [JSON.stringify(['ac000012'])])
      expect(rows.rowCount).toBe(0)
    })

    it('takes a large list as one parameter rather than one each', async () => {
      const many = Array.from({ length: 20_000 }, (_, i) => `BULK${i}`)
      many.push('D0001')
      const rows = await client.query(missingSql(true, null), [JSON.stringify(many)])
      expect(rows.rows.map((r) => r.sku)).toEqual(['D0001'])
    })

    it('still answers when shop-variations is not installed', async () => {
      await client.query(`DROP TABLE "svr_variants"`)
      const absent = await client.query(`SELECT to_regclass('svr_variants')::text AS "present"`)
      expect(absent.rows[0].present).toBeNull()

      const rows = await client.query(missingSql(false, null), [
        JSON.stringify(['AC000012', 'AC000013', 'D0001']),
      ])
      expect(rows.rows.map((r) => [r.sku, r.parent_name])).toEqual([
        ['D0001', null],
        ['AC000013', null],
        ['AC000012', null],
      ])
    })
  })

  it('prunes the log to the last fifty', async () => {
    for (let i = 0; i < 55; i++) {
      await client.query(
        `INSERT INTO "stk_import_log" ("trigger", "status", "rows_in_file") VALUES ('CRON', 'COMPLETED', $1)`,
        [i]
      )
    }
    await client.query(
      `DELETE FROM "stk_import_log" WHERE "id" NOT IN (SELECT "id" FROM "stk_import_log" ORDER BY "created_at" DESC LIMIT 50)`
    )
    const rows = await client.query(`SELECT count(*)::int AS c FROM "stk_import_log"`)
    expect(rows.rows[0].c).toBe(50)
  })
})

// The statements below are the ones lib/db.ts sends, with Prisma's `${}` holes
// rewritten as $n placeholders. Keep them in step with lib/db.ts: this file is
// only worth having while it is testing what actually ships.

const claimSql = `
  INSERT INTO "stk_import_job"
    ("id", "status", "trigger", "pending", "rows_in_file", "matched", "changed",
     "applied", "unmatched", "missing", "zeroed", "bad_values", "error", "lease_until",
     "run_by", "started_at", "updated_at", "finished_at")
  VALUES
    ('singleton', 'FETCHING', $1, '[]'::jsonb, 0, 0, 0, 0, 0, 0, 0, '[]'::jsonb, NULL,
     CURRENT_TIMESTAMP + make_interval(secs => ${LEASE_MS / 1000}), $2,
     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
  ON CONFLICT ("id") DO UPDATE SET
    "status"       = 'FETCHING',
    "trigger"      = $1,
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
    "run_by"       = $2,
    "started_at"   = CURRENT_TIMESTAMP,
    "updated_at"   = CURRENT_TIMESTAMP,
    "finished_at"  = NULL
  WHERE "stk_import_job"."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
     OR "stk_import_job"."lease_until" IS NULL
     OR "stk_import_job"."lease_until" < CURRENT_TIMESTAMP
`

const leaseSql = `
  UPDATE "stk_import_job" SET
    "lease_until" = CURRENT_TIMESTAMP + make_interval(secs => ${LEASE_MS / 1000}),
    "updated_at"  = CURRENT_TIMESTAMP
  WHERE "id" = 'singleton'
    AND "status" IN ('FETCHING', 'APPLYING')
    AND ("lease_until" IS NULL OR "lease_until" < CURRENT_TIMESTAMP)
`

function missingSql(withParents: boolean, limit: number | null): string {
  const limitClause = limit === null ? '' : `LIMIT ${limit}`
  if (withParents) {
    return `
      SELECT p."id", p."sku", p."name", p."status", p."stock_count", p."track_inventory",
             p."catalogue_hidden", parent."id" AS "parent_id", parent."name" AS "parent_name"
      FROM "shp_products" p
      LEFT JOIN "svr_variants" v ON v."child_product_id" = p."id"
      LEFT JOIN "shp_products" parent ON parent."id" = v."product_id"
      WHERE p."sku" IN (SELECT jsonb_array_elements_text($1::jsonb))
      ORDER BY COALESCE(parent."name", p."name") ASC, p."name" ASC
      ${limitClause}
    `
  }
  return `
    SELECT p."id", p."sku", p."name", p."status", p."stock_count", p."track_inventory",
           p."catalogue_hidden", NULL::text AS "parent_id", NULL::text AS "parent_name"
    FROM "shp_products" p
    WHERE p."sku" IN (SELECT jsonb_array_elements_text($1::jsonb))
    ORDER BY p."name" ASC
    ${limitClause}
  `
}

function batchSql(enableTracking: boolean, pairs: number): string {
  const tracking = enableTracking
    ? `, "track_inventory" = CASE WHEN p."type" = 'PHYSICAL' THEN true ELSE p."track_inventory" END`
    : ''
  const changed = enableTracking
    ? `AND (p."stock_count" IS DISTINCT FROM v."qty" OR (p."type" = 'PHYSICAL' AND NOT p."track_inventory"))`
    : `AND p."stock_count" IS DISTINCT FROM v."qty"`
  // The same VALUES shape Prisma.join produces, one (sku, qty) row per pair.
  const values = Array.from(
    { length: pairs },
    (_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::integer)`
  ).join(', ')
  return `
    UPDATE "shp_products" AS p SET
      "stock_count" = v."qty"${tracking},
      "low_stock_alerted_at" = CASE
        WHEN p."low_stock_threshold" IS NOT NULL AND v."qty" > p."low_stock_threshold" THEN NULL
        ELSE p."low_stock_alerted_at"
      END,
      "updated_at" = CURRENT_TIMESTAMP
    FROM (VALUES ${values}) AS v("sku", "qty")
    WHERE p."sku" = v."sku"
      ${changed}
  `
}
