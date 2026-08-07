import { describe, it, expect } from 'vitest'
import { buildStockDiff, MissingColumnError } from '@/modules/stock-import-for-shop/lib/diff'
import { iterateCsvRows } from '@/modules/stock-import-for-shop/lib/csv'
import type { ShopSku } from '@/modules/stock-import-for-shop/lib/db'

function product(sku: string, stock: number | null, extra?: Partial<ShopSku>): ShopSku {
  return { sku, stock, tracked: true, physical: true, ...extra }
}

const OPTIONS = { missingBehaviour: 'IGNORE' as const, enableTracking: false }
const rows = (csv: string) => iterateCsvRows(csv)

describe('buildStockDiff', () => {
  it('writes only the products whose count actually moved', () => {
    const csv = 'ProductCode,FreeStock\nAC1,10\nAC2,5\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 10), product('AC2', 99)], 'ProductCode', 'FreeStock', OPTIONS)

    expect(diff.pending).toEqual([['AC2', 5]])
    expect(diff.changed).toBe(1)
    expect(diff.matched).toBe(2)
    expect(diff.rowsInFile).toBe(2)
  })

  it('treats a count the shop has never had as a change', () => {
    const csv = 'ProductCode,FreeStock\nAC1,10\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', null)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([['AC1', 10]])
    expect(diff.changed).toBe(1)
  })

  it('matches regardless of case and surrounding spaces, and writes the shop’s own spelling', () => {
    const csv = 'ProductCode,FreeStock\n  ac1  ,7\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([['AC1', 7]])
  })

  it('counts codes the shop does not stock, once each however often they are listed', () => {
    const csv = 'ProductCode,FreeStock\nZZ9,4\nZZ9,4\nAC1,1\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.unmatched).toBe(1)
    expect(diff.matched).toBe(1)
    expect(diff.rowsInFile).toBe(3)
  })

  it('lets the last row win when a code is listed twice, and counts it as one change', () => {
    const csv = 'ProductCode,FreeStock\nAC1,4\nAC1,9\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([['AC1', 9]])
    expect(diff.changed).toBe(1)
  })

  it('leaves a product alone when its stock cell is blank rather than zeroing it', () => {
    const csv = 'ProductCode,FreeStock\nAC1,\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 12)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([])
    expect(diff.matched).toBe(1)
    expect(diff.badValues).toEqual([])
  })

  it('reports an unreadable stock cell as an example without writing anything', () => {
    const csv = 'ProductCode,FreeStock\nAC1,In stock\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 12)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([])
    expect(diff.badValues).toEqual(['AC1: "In stock"'])
  })

  it('counts products the file never mentions, and leaves them alone by default', () => {
    const csv = 'ProductCode,FreeStock\nAC1,3\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0), product('AC2', 50)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.missing).toBe(1)
    expect(diff.zeroed).toBe(0)
    expect(diff.pending).toEqual([['AC1', 3]])
  })

  it('zeroes products the file never mentions when asked to', () => {
    const csv = 'ProductCode,FreeStock\nAC1,3\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0), product('AC2', 50)], 'ProductCode', 'FreeStock', {
      missingBehaviour: 'ZERO',
      enableTracking: false,
    })
    expect(diff.pending).toEqual([
      ['AC1', 3],
      ['AC2', 0],
    ])
    expect(diff.zeroed).toBe(1)
    expect(diff.changed).toBe(2)
  })

  it('does not re-zero a missing product that is already at zero', () => {
    const csv = 'ProductCode,FreeStock\nAC1,3\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 3), product('AC2', 0)], 'ProductCode', 'FreeStock', {
      missingBehaviour: 'ZERO',
      enableTracking: false,
    })
    expect(diff.pending).toEqual([])
    expect(diff.missing).toBe(1)
    expect(diff.zeroed).toBe(0)
  })

  it('counts a product whose cell was unreadable as present, not missing', () => {
    const csv = 'ProductCode,FreeStock\nAC1,rubbish\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 4)], 'ProductCode', 'FreeStock', {
      missingBehaviour: 'ZERO',
      enableTracking: false,
    })
    expect(diff.missing).toBe(0)
    expect(diff.pending).toEqual([])
  })

  it('picks up a product whose count agrees but whose tracking is still off', () => {
    const csv = 'ProductCode,FreeStock\nAC1,10\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 10, { tracked: false })], 'ProductCode', 'FreeStock', {
      missingBehaviour: 'IGNORE',
      enableTracking: true,
    })
    expect(diff.pending).toEqual([['AC1', 10]])
    // Its stock is not changing - only the enforcement flag is.
    expect(diff.changed).toBe(0)
  })

  it('leaves a non-physical product’s tracking alone', () => {
    const csv = 'ProductCode,FreeStock\nAC1,10\n'
    const diff = buildStockDiff(
      rows(csv),
      [product('AC1', 10, { tracked: false, physical: false })],
      'ProductCode',
      'FreeStock',
      { missingBehaviour: 'IGNORE', enableTracking: true }
    )
    expect(diff.pending).toEqual([])
  })

  it('updates every product sharing a code when two differ only by case', () => {
    const csv = 'ProductCode,FreeStock\nAC1,6\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0), product('ac1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([
      ['AC1', 6],
      ['ac1', 6],
    ])
    expect(diff.matched).toBe(1)
    expect(diff.changed).toBe(2)
  })

  it('reads the columns by name wherever they sit, and ignores the rest', () => {
    const csv = 'ProductDescription,FreeStock,ProductCode,DueDate\nA chair,8,AC1,13/08/2026\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.pending).toEqual([['AC1', 8]])
  })

  it('refuses a file with no product code column rather than guessing', () => {
    const csv = 'Item,FreeStock\nAC1,8\n'
    expect(() => buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)).toThrow(
      MissingColumnError
    )
  })

  it('names the columns the file does have, so the owner can pick one', () => {
    const csv = 'Item,OnHand\nAC1,8\n'
    expect(() => buildStockDiff(rows(csv), [], 'ProductCode', 'FreeStock', OPTIONS)).toThrow(/Item, OnHand/)
  })

  it('refuses an empty file', () => {
    expect(() => buildStockDiff(rows(''), [], 'ProductCode', 'FreeStock', OPTIONS)).toThrow(MissingColumnError)
  })

  it('skips rows with no code at all', () => {
    const csv = 'ProductCode,FreeStock\n,9\nAC1,9\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(diff.rowsInFile).toBe(2)
    expect(diff.matched).toBe(1)
    expect(diff.unmatched).toBe(0)
  })

  it('ignores a shop product whose SKU is only whitespace', () => {
    const csv = 'ProductCode,FreeStock\nAC1,9\n'
    const diff = buildStockDiff(rows(csv), [product('AC1', 0), product('   ', 5)], 'ProductCode', 'FreeStock', {
      missingBehaviour: 'ZERO',
      enableTracking: false,
    })
    expect(diff.pending).toEqual([['AC1', 9]])
    expect(diff.missing).toBe(0)
  })

  it('walks a one-pass generator exactly once', () => {
    // The real import hands in a generator over six megabytes of CSV. Anything
    // that re-read it would work in tests over an array and fail in production.
    let reads = 0
    function* once(): Generator<string[]> {
      reads++
      yield ['ProductCode', 'FreeStock']
      yield ['AC1', '3']
    }
    const diff = buildStockDiff(once(), [product('AC1', 0)], 'ProductCode', 'FreeStock', OPTIONS)
    expect(reads).toBe(1)
    expect(diff.pending).toEqual([['AC1', 3]])
  })
})
