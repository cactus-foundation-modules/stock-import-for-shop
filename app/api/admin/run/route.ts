import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getJobStatus } from '@/modules/stock-import-for-shop/lib/db'
import { startRun } from '@/modules/stock-import-for-shop/lib/import-run'

// The Fetch Latest Stock button. Starts a run and applies as much of it as the
// route's sixty seconds allow; anything left over is picked up by /run/step,
// which the button calls until the job says it is done.
export async function POST() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const outcome = await startRun('MANUAL', gate.user?.id ?? null)
  return NextResponse.json({ outcome, status: await getJobStatus() })
}
