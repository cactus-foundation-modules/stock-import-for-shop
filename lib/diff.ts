import { findColumn, normaliseSku, parseStockValue } from '@/modules/stock-import-for-shop/lib/csv'
import type { ShopSku } from '@/modules/stock-import-for-shop/lib/db'
import type { StkMissingBehaviour } from '@/modules/stock-import-for-shop/lib/types'

// Working out what a supplier's stock file actually changes, with no database
// anywhere near it. Pure in, pure out, so the awkward cases - a code that
// appears twice, a blank cell, a product the file has never heard of - can be
// pinned down in tests rather than discovered on a live catalogue.

export type StockDiff = {
  /** (SKU exactly as the shop stores it, new count) pairs still to write. */
  pending: [string, number][]
  /** Data rows read from the file, heading line excluded. */
  rowsInFile: number
  /** Distinct file codes that named a product in the shop. */
  matched: number
  /** Distinct file codes the shop has no product for. */
  unmatched: number
  /** Products in the shop whose SKU the file never mentioned. */
  missing: number
  /** Products whose stock count this run actually changes. */
  changed: number
  /** Of those, how many are being set to zero because they went missing. */
  zeroed: number
  /** Unreadable stock cells, capped - enough to show the owner the shape of it. */
  badValues: string[]
}

export type DiffOptions = {
  missingBehaviour: StkMissingBehaviour
  /** Whether matched products should also have inventory tracking switched on. */
  enableTracking: boolean
}

const BAD_VALUE_EXAMPLES = 5

export class MissingColumnError extends Error {
  constructor(
    readonly column: string,
    readonly available: string[]
  ) {
    const headings = available.filter(Boolean).join(', ')
    super(`The file has no "${column}" column. It has: ${headings || '(no headings at all)'}`)
    this.name = 'MissingColumnError'
  }
}

/**
 * Reads a stock file against the shop's SKUs and returns the writes it implies.
 *
 * `rows` is the whole file including its heading line, walked exactly once (it
 * may be a generator over six megabytes of CSV, so it is never re-read and
 * never held whole). The headings decide which columns matter; a file missing
 * either of them throws, because carrying on would mean writing nonsense over a
 * working catalogue.
 */
export function buildStockDiff(
  rows: Iterable<string[]>,
  shopSkus: ShopSku[],
  skuColumn: string,
  stockColumn: string,
  options: DiffOptions
): StockDiff {
  // The shop side, indexed by the same normalisation the file gets. A list per
  // key, not a single entry: SKUs are unique case-sensitively, so "ac1" and
  // "AC1" can both exist and the file's "AC1" honestly means both.
  const byNormalised = new Map<string, ShopSku[]>()
  const originalStock = new Map<string, number | null>()
  for (const entry of shopSkus) {
    const key = normaliseSku(entry.sku)
    if (!key) continue
    originalStock.set(entry.sku, entry.stock)
    const existing = byNormalised.get(key)
    if (existing) existing.push(entry)
    else byNormalised.set(key, [entry])
  }

  const iterator = rows[Symbol.iterator]()
  const first = iterator.next()
  if (first.done) throw new MissingColumnError(skuColumn, [])
  const heading = first.value
  const skuIndex = findColumn(heading, skuColumn)
  const stockIndex = findColumn(heading, stockColumn)
  if (skuIndex === -1) throw new MissingColumnError(skuColumn, heading)
  if (stockIndex === -1) throw new MissingColumnError(stockColumn, heading)

  // Keyed by the shop's own SKU, so a code appearing twice in the file resolves
  // to one write rather than two contradictory ones in the same statement. The
  // later row wins, which is the only reading of a file that lists a code twice
  // that does not require guessing what the supplier meant.
  const writes = new Map<string, number>()
  const seenKeys = new Set<string>()
  const badValues: string[] = []
  let rowsInFile = 0
  let matched = 0
  let unmatched = 0

  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value
    rowsInFile++
    const key = normaliseSku(row[skuIndex] ?? '')
    if (!key) continue

    const products = byNormalised.get(key)
    if (!products) {
      // Count a code the shop does not stock once, however often it is listed.
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        unmatched++
      }
      continue
    }
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      matched++
    }

    const raw = row[stockIndex] ?? ''
    const quantity = parseStockValue(raw)
    if (quantity === null) {
      // A blank cell is the supplier saying nothing, not saying none. Leave the
      // count alone and note it, rather than zeroing a product on a typo.
      if (raw.trim() && badValues.length < BAD_VALUE_EXAMPLES) {
        badValues.push(`${row[skuIndex]}: "${raw.trim()}"`)
      }
      continue
    }

    for (const product of products) {
      const stockDiffers = product.stock !== quantity
      const needsTracking = options.enableTracking && product.physical && !product.tracked
      if (!stockDiffers && !needsTracking) continue
      writes.set(product.sku, quantity)
    }
  }

  // Products the file never mentioned. Zeroing them is a deliberate choice: it
  // is right when the file is the whole catalogue, and catastrophic when it is
  // one supplier's slice of it, so it is off unless the owner says otherwise.
  let missing = 0
  let zeroed = 0
  for (const product of shopSkus) {
    const key = normaliseSku(product.sku)
    if (!key || seenKeys.has(key)) continue
    missing++
    if (options.missingBehaviour === 'ZERO' && product.stock !== 0) {
      writes.set(product.sku, 0)
      zeroed++
    }
  }

  // Counted from the finished set rather than tallied along the way, so a code
  // listed twice - or a product written and then zeroed - is counted once.
  let changed = 0
  for (const [sku, quantity] of writes) {
    if (originalStock.get(sku) !== quantity) changed++
  }

  return { pending: [...writes.entries()], rowsInFile, matched, unmatched, missing, changed, zeroed, badValues }
}
