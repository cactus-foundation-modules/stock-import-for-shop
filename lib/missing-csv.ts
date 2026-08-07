import type { StkMissingProduct } from '@/modules/stock-import-for-shop/lib/types'

// Turning the "not in your supplier's file" list into a spreadsheet, because
// four hundred product codes is something an owner emails to their supplier
// rather than reads off a screen.
//
// Kept pure and away from the database so the awkward bits - a product name
// with a comma in it, a name a spreadsheet would rather treat as a formula -
// can be pinned down in tests.

const HEADINGS = ['Product code', 'Product', 'Part of', 'Status', 'Stock count', 'Stock enforced'] as const

const STATUS_WORD: Record<StkMissingProduct['status'], string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Live',
  ARCHIVED: 'Archived',
}

/**
 * Escapes one cell.
 *
 * Quoting is the ordinary CSV rule. The leading apostrophe is not: a cell
 * starting with =, +, - or @ is read as a formula by every spreadsheet there
 * is, so a product legitimately named "-40% Clearance" would otherwise open as
 * an error - or worse, as something that runs.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** The whole list as a CSV body, headings first, CRLF line endings for Excel. */
export function toMissingCsv(products: StkMissingProduct[]): string {
  const lines = [HEADINGS.join(',')]
  for (const product of products) {
    lines.push(
      [
        csvCell(product.sku),
        csvCell(product.name),
        csvCell(product.parentName ?? ''),
        csvCell(STATUS_WORD[product.status] ?? product.status),
        csvCell(product.stock === null ? '' : String(product.stock)),
        csvCell(product.tracked ? 'Yes' : 'No'),
      ].join(',')
    )
  }
  // A byte-order mark, so Excel on Windows does not mangle an accented name.
  return `﻿${lines.join('\r\n')}\r\n`
}
