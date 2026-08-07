import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getJob, getSettings } from '@/modules/stock-import-for-shop/lib/db'
import { continueRun, startRun } from '@/modules/stock-import-for-shop/lib/import-run'
import { isRunDue } from '@/modules/stock-import-for-shop/lib/schedule'

// Runs every hour on the fifth minute (manifest cronJobs). The hour is the tick,
// not the schedule: how often a refresh actually happens is the owner's setting,
// and this asks isRunDue whether enough of it has passed. A Vercel Cron entry is
// fixed at deploy time, so this is the only way a frequency can be a setting at
// all.
//
// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - no separate secret scheme needed.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  // An unfinished run comes first. A big catalogue that ran out of clock last
  // tick is more urgent than starting a fresh download over the top of it.
  const job = await getJob()
  if (job && (job.status === 'FETCHING' || job.status === 'APPLYING')) {
    const outcome = await continueRun()
    return NextResponse.json({ resumed: true, outcome })
  }

  const settings = await getSettings()
  if (!settings.csvUrl) {
    return NextResponse.json({ skipped: 'No stock file address has been set.' })
  }
  if (!isRunDue(settings.frequencyHours, settings.lastRunAt ? new Date(settings.lastRunAt) : null, new Date())) {
    return NextResponse.json({ skipped: 'Not due yet.' })
  }

  const outcome = await startRun('CRON', null)
  return NextResponse.json({ resumed: false, outcome })
}
