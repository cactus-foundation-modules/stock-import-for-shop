import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSettings, updateSettings } from '@/modules/stock-import-for-shop/lib/db'
import { isValidFrequency } from '@/modules/stock-import-for-shop/lib/schedule'
import { assertSafeFeedUrl, FeedError } from '@/modules/stock-import-for-shop/lib/fetch-feed'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  return NextResponse.json({ settings: await getSettings() })
}

const Body = z.object({
  csvUrl: z.string().nullable().optional(),
  skuColumn: z.string().min(1).max(200).optional(),
  stockColumn: z.string().min(1).max(200).optional(),
  frequencyHours: z.number().int().optional(),
  missingBehaviour: z.enum(['IGNORE', 'ZERO']).optional(),
  enableTracking: z.boolean().optional(),
  authUser: z.string().max(200).nullable().optional(),
  authPassword: z.string().max(500).nullable().optional(),
})

export async function PUT(request: Request) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const patch = parsed.data

  if (patch.frequencyHours !== undefined && !isValidFrequency(patch.frequencyHours)) {
    return NextResponse.json({ error: 'That is not one of the schedules on offer.' }, { status: 400 })
  }
  // Check the address here rather than at the first cron tick, so a typo is
  // caught while the owner is still looking at the screen.
  if (patch.csvUrl) {
    try {
      assertSafeFeedUrl(patch.csvUrl)
    } catch (error) {
      const message = error instanceof FeedError ? error.message : 'That web address cannot be used.'
      return NextResponse.json({ error: message }, { status: 400 })
    }
  }

  await updateSettings(patch)
  return NextResponse.json({ settings: await getSettings() })
}
