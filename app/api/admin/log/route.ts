import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { listLog } from '@/modules/stock-import-for-shop/lib/db'

export async function GET() {
  const gate = await requireShopUser('shop.products', { allowAccess: true })
  if (gate.error) return gate.error
  return NextResponse.json({ entries: await listLog(20) })
}
