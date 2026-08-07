import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { finishJob, getJob, getJobStatus, writeLog } from '@/modules/stock-import-for-shop/lib/db'

// Stops a run part-way. Whatever has already been written stays written - stock
// counts are not a transaction and half a catalogue at today's figures is
// better than all of it at last week's - so the log records what got through.
export async function POST() {
  const gate = await requireShopUser('shop.products')
  if (gate.error) return gate.error

  const job = await getJob()
  if (!job || job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
    return NextResponse.json({ status: await getJobStatus() })
  }

  await finishJob('CANCELLED', 'Stopped from the Products page.')
  await writeLog({
    trigger: job.trigger,
    status: 'CANCELLED',
    rowsInFile: job.rowsInFile,
    matched: job.matched,
    updatedCount: job.applied,
    unmatched: job.unmatched,
    missing: job.missing,
    zeroed: job.zeroed,
    durationMs: Date.now() - job.startedAt.getTime(),
    error: 'Stopped part-way. The products already updated keep their new figures.',
    runBy: gate.user?.id ?? null,
  })
  return NextResponse.json({ status: await getJobStatus() })
}
