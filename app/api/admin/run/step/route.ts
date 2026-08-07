import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getJobStatus } from '@/modules/stock-import-for-shop/lib/db'
import { continueRun } from '@/modules/stock-import-for-shop/lib/import-run'

// Applies the next slice of an unfinished run. Called in a loop by the button
// until the status comes back done, so a first import over a big catalogue
// finishes without any single request going near the sixty-second ceiling.
export async function POST() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const outcome = await continueRun()
  return NextResponse.json({ outcome, status: await getJobStatus() })
}
