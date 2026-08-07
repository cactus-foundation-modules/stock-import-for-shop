import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSettings } from '@/modules/stock-import-for-shop/lib/db'
import { FeedError } from '@/modules/stock-import-for-shop/lib/fetch-feed'
import { probeFeed } from '@/modules/stock-import-for-shop/lib/probe'

const Body = z.object({
  csvUrl: z.string().optional(),
  skuColumn: z.string().optional(),
  stockColumn: z.string().optional(),
})

// Reads the supplier's file and reports what it found, changing nothing. Takes
// the values from the form rather than the saved ones, so the owner can try a
// link before committing to it.
export async function POST(request: Request) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const saved = await getSettings()
  const url = parsed.data.csvUrl?.trim() || saved.csvUrl
  if (!url) return NextResponse.json({ error: 'Enter the address of your stock file first.' }, { status: 400 })

  try {
    const result = await probeFeed(
      url,
      parsed.data.skuColumn?.trim() || saved.skuColumn,
      parsed.data.stockColumn?.trim() || saved.stockColumn
    )
    return NextResponse.json({ result })
  } catch (error) {
    const message = error instanceof FeedError ? error.message : (error as Error)?.message || 'Could not read that file.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
