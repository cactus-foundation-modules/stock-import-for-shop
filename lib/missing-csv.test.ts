import { describe, expect, it } from 'vitest'
import { csvCell, toMissingCsv } from '@/modules/stock-import-for-shop/lib/missing-csv'
import type { StkMissingProduct } from '@/modules/stock-import-for-shop/lib/types'

function product(overrides: Partial<StkMissingProduct> = {}): StkMissingProduct {
  return {
    id: 'p1',
    sku: 'AC000012',
    name: 'Zure Headrest - White Mesh / Charcoal',
    status: 'ACTIVE',
    stock: 28,
    tracked: true,
    hidden: true,
    parentId: 'p0',
    parentName: 'Zure Headrest',
    ...overrides,
  }
}

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('AC000012')).toBe('AC000012')
  })

  it('quotes a value containing the delimiter', () => {
    expect(csvCell('Desk, white')).toBe('"Desk, white"')
  })

  it('doubles an embedded quote', () => {
    expect(csvCell('Desk 60" wide')).toBe('"Desk 60"" wide"')
  })

  it('quotes a value containing a line break', () => {
    expect(csvCell('Desk\nwhite')).toBe('"Desk\nwhite"')
  })

  it('defuses a value a spreadsheet would read as a formula', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('-40% Clearance')).toBe("'-40% Clearance")
    expect(csvCell('+Extra')).toBe("'+Extra")
    expect(csvCell('@home')).toBe("'@home")
  })

  it('quotes a defused value that also needs quoting', () => {
    expect(csvCell('=A1,B2')).toBe('"\'=A1,B2"')
  })
})

describe('toMissingCsv', () => {
  it('writes headings even when there is nothing to report', () => {
    const csv = toMissingCsv([])
    expect(csv).toBe('﻿Product code,Product,Part of,Status,Stock count,Stock enforced\r\n')
  })

  it('writes one row per product, with the parent listing', () => {
    const lines = toMissingCsv([product()]).split('\r\n')
    expect(lines[1]).toBe('AC000012,Zure Headrest - White Mesh / Charcoal,Zure Headrest,Live,28,Yes')
  })

  it('leaves the parent column empty for a product that is a listing itself', () => {
    const lines = toMissingCsv([product({ parentId: null, parentName: null })]).split('\r\n')
    expect(lines[1]).toContain('Zure Headrest - White Mesh / Charcoal,,Live,')
  })

  it('distinguishes a stock count of nothing from no stock count at all', () => {
    const [, zero] = toMissingCsv([product({ stock: 0 })]).split('\r\n')
    const [, unset] = toMissingCsv([product({ stock: null })]).split('\r\n')
    expect(zero).toContain(',Live,0,Yes')
    expect(unset).toContain(',Live,,Yes')
  })

  it('says so when a count is recorded but not enforced', () => {
    const lines = toMissingCsv([product({ tracked: false })]).split('\r\n')
    expect(lines[1]?.endsWith(',No')).toBe(true)
  })

  it('translates the shop status rather than shouting it', () => {
    const words = (['DRAFT', 'ACTIVE', 'ARCHIVED'] as const).map(
      (status) => toMissingCsv([product({ status })]).split('\r\n')[1]?.split(',')[3]
    )
    expect(words).toEqual(['Draft', 'Live', 'Archived'])
  })
})
