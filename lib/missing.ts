import { findColumn, iterateCsvRows, normaliseSku } from '@/modules/stock-import-for-shop/lib/csv'
import { getSettings, getSkuStock, listMissingProducts } from '@/modules/stock-import-for-shop/lib/db'
import { MissingColumnError } from '@/modules/stock-import-for-shop/lib/diff'
import { fetchFeed, FeedError } from '@/modules/stock-import-for-shop/lib/fetch-feed'
import type { StkMissingReport } from '@/modules/stock-import-for-shop/lib/types'

// Which of the shop's products the supplier's file never mentions, by name
// rather than as a number.
//
// The run log has always reported the count. The count is the wrong end of the
// question: an owner looking at "412 of your products are not in the file"
// wants to know whether those 412 are a range the supplier dropped, a batch
// imported with the wrong codes, or four hundred variations of one chair - and
// there is no arithmetic that answers that.
//
// Read against the SAVED settings rather than whatever is typed in the form.
// This is a report on the file the shop is actually importing, and a list drawn
// from a url nobody has committed to yet would be a report on nothing.

/** How many rows the screen gets. The download is not capped. */
export const MISSING_DISPLAY_LIMIT = 2000

export async function findMissingProducts(limit: number | null): Promise<StkMissingReport> {
  const settings = await getSettings()
  if (!settings.csvUrl) {
    throw new FeedError('Add the address of your stock file first, and save it.')
  }

  const body = await fetchFeed(settings.csvUrl)
  const shopSkus = await getSkuStock()

  const iterator = iterateCsvRows(body.text)[Symbol.iterator]()
  const first = iterator.next()
  const heading = first.done ? [] : first.value
  const skuIndex = findColumn(heading, settings.skuColumn)
  // Without the code column every product looks missing, which would be a
  // report saying the whole catalogue has been dropped. Refuse instead.
  if (skuIndex === -1) throw new MissingColumnError(settings.skuColumn, heading)

  const fileKeys = new Set<string>()
  let rowsInFile = 0
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    rowsInFile++
    const key = normaliseSku(next.value[skuIndex] ?? '')
    if (key) fileKeys.add(key)
  }

  // Same comparison the import itself makes, so this list and the run log's
  // "not in file" count can never disagree.
  const missing: string[] = []
  for (const product of shopSkus) {
    const key = normaliseSku(product.sku)
    if (!key || fileKeys.has(key)) continue
    missing.push(product.sku)
  }

  const products = await listMissingProducts(missing, limit)
  return {
    total: missing.length,
    products,
    truncated: products.length < missing.length,
    rowsInFile,
  }
}
