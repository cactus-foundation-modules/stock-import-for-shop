import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { MissingColumnError } from '@/modules/stock-import-for-shop/lib/diff'
import { FeedError } from '@/modules/stock-import-for-shop/lib/fetch-feed'
import { findMissingProducts, MISSING_DISPLAY_LIMIT } from '@/modules/stock-import-for-shop/lib/missing'
import { toMissingCsv } from '@/modules/stock-import-for-shop/lib/missing-csv'

// The products the supplier's file does not cover, either as a list for the
// screen or as a spreadsheet to send to the supplier. Reads the file and
// changes nothing, same as the Test button.

export async function GET(request: Request) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const wantsCsv = new URL(request.url).searchParams.get('format') === 'csv'

  try {
    // The screen takes a slice; the download takes the lot, because the whole
    // point of the download is that the list is too long to read.
    const report = await findMissingProducts(wantsCsv ? null : MISSING_DISPLAY_LIMIT)
    if (!wantsCsv) return NextResponse.json({ report })

    return new Response(toMissingCsv(report.products), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="products-not-in-stock-file.csv"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message =
      error instanceof FeedError || error instanceof MissingColumnError
        ? error.message
        : (error as Error)?.message || 'Could not read that file.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
