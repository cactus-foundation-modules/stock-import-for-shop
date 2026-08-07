import { findColumn, iterateCsvRows, normaliseSku, parseStockValue } from '@/modules/stock-import-for-shop/lib/csv'
import { fetchFeed } from '@/modules/stock-import-for-shop/lib/fetch-feed'
import { getSkuStock } from '@/modules/stock-import-for-shop/lib/db'
import type { StkProbeResult } from '@/modules/stock-import-for-shop/lib/types'

// What the Test button does: fetch the file, read it against the catalogue, and
// report what WOULD happen - without writing a single stock count.
//
// This is the answer to the only question an owner actually has when setting
// one of these up: is this the right link, and does it know about my products?
// A match count answers it in a way no amount of column-name documentation can.

const SAMPLE_ROWS = 5

export async function probeFeed(url: string, skuColumn: string, stockColumn: string): Promise<StkProbeResult> {
  const body = await fetchFeed(url)
  const shopSkus = await getSkuStock()
  const shopKeys = new Set(shopSkus.map((p) => normaliseSku(p.sku)).filter(Boolean))

  const iterator = iterateCsvRows(body.text)[Symbol.iterator]()
  const first = iterator.next()
  const columns = first.done ? [] : first.value
  const skuIndex = findColumn(columns, skuColumn)
  const stockIndex = findColumn(columns, stockColumn)

  const sampleRows: string[][] = []
  const badValueExamples: string[] = []
  const fileKeys = new Set<string>()
  let totalRows = 0

  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value
    totalRows++
    if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(row)
    if (skuIndex === -1) continue
    const key = normaliseSku(row[skuIndex] ?? '')
    if (key) fileKeys.add(key)
    if (stockIndex === -1) continue
    const raw = row[stockIndex] ?? ''
    if (raw.trim() && parseStockValue(raw) === null && badValueExamples.length < SAMPLE_ROWS) {
      badValueExamples.push(`${row[skuIndex] ?? '?'}: "${raw.trim()}"`)
    }
  }

  let matchedSkus = 0
  for (const key of fileKeys) if (shopKeys.has(key)) matchedSkus++
  let missingSkus = 0
  for (const key of shopKeys) if (!fileKeys.has(key)) missingSkus++

  return {
    columns,
    sampleRows,
    totalRows,
    matchedSkus,
    missingSkus,
    skuColumnFound: skuIndex !== -1,
    stockColumnFound: stockIndex !== -1,
    badValueExamples,
    bytes: body.bytes,
  }
}
