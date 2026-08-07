import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getJobStatus, getSettings } from '@/modules/stock-import-for-shop/lib/db'

// Also answers "is a stock file set up at all", because the Products page button
// needs to know that and only shop MANAGERS may read the settings themselves -
// a boolean is not a setting, and the button would otherwise be invisible to
// exactly the staff whose job it is to press it.
export async function GET() {
  const gate = await requireShopUser('shop.products', { allowAccess: true })
  if (gate.error) return gate.error
  const [status, settings] = await Promise.all([getJobStatus(), getSettings()])
  return NextResponse.json({ status, configured: !!settings.csvUrl })
}
