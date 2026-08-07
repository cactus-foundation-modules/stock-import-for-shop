import { iterateCsvRows } from '@/modules/stock-import-for-shop/lib/csv'
import { buildStockDiff, MissingColumnError } from '@/modules/stock-import-for-shop/lib/diff'
import { fetchFeed, FeedError } from '@/modules/stock-import-for-shop/lib/fetch-feed'
import {
  applyStockBatch,
  claimJob,
  finishJob,
  getJob,
  getSettings,
  getSkuStock,
  leaseJob,
  markRunStarted,
  releaseLease,
  saveBatchProgress,
  saveFetchResult,
  writeLog,
  type StkJobRow,
} from '@/modules/stock-import-for-shop/lib/db'
import type { StkTrigger } from '@/modules/stock-import-for-shop/lib/types'

// One stock refresh, start to finish - and, when it does not fit in one go,
// start to somewhere-in-the-middle-to-finish.
//
// Module routes on Vercel are capped at sixty seconds and the cap cannot be
// raised, so a first run over a twenty-thousand-line catalogue has to be able
// to stop cleanly and be picked up again. That is the whole reason the job
// table exists: the diff is worked out once, parked, and then applied a batch
// at a time by whoever turns up next - the next press of the button, or the
// next hourly cron tick.

/** Rows per UPDATE. Big enough to be worth a round trip, small enough to abandon. */
const BATCH_SIZE = 1000

/** Stop and save with fifteen seconds of the route's sixty still in hand. */
const BUDGET_MS = 45_000

export type RunOutcome = {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'BUSY' | 'SKIPPED'
  message: string
  applied?: number
  remaining?: number
}

/**
 * Starts a fresh run: claim the slot, download, diff, then apply as much as the
 * clock allows. Refuses rather than queues if one is already going - two copies
 * writing the same rows is not twice as fast, it is twice as much lock
 * contention and a confusing pair of log entries.
 */
export async function startRun(trigger: StkTrigger, runBy: string | null): Promise<RunOutcome> {
  const startedAt = Date.now()
  const settings = await getSettings()
  if (!settings.csvUrl) {
    return { status: 'SKIPPED', message: 'No stock file address has been set yet.' }
  }

  if (!(await claimJob(trigger, runBy))) {
    return { status: 'BUSY', message: 'A stock refresh is already running.' }
  }

  // Stamp the schedule the moment the run is claimed, not when it finishes. A
  // run that fails at the supplier's end must still push the next automatic
  // attempt out by a full interval, or a broken feed turns into an hourly
  // retry storm against someone else's server.
  await markRunStarted(new Date())

  try {
    const body = await fetchFeed(settings.csvUrl)
    const shopSkus = await getSkuStock()
    const diff = buildStockDiff(
      iterateCsvRows(body.text),
      shopSkus,
      settings.skuColumn,
      settings.stockColumn,
      { missingBehaviour: settings.missingBehaviour, enableTracking: settings.enableTracking }
    )

    await saveFetchResult({
      pending: diff.pending,
      rowsInFile: diff.rowsInFile,
      matched: diff.matched,
      changed: diff.changed,
      unmatched: diff.unmatched,
      missing: diff.missing,
      zeroed: diff.zeroed,
      badValues: diff.badValues,
    })

    return applyRemaining(startedAt, settings.enableTracking)
  } catch (error) {
    const message = describeFailure(error)
    await finishJob('FAILED', message)
    await writeLog({
      trigger,
      status: 'FAILED',
      rowsInFile: 0,
      matched: 0,
      updatedCount: 0,
      unmatched: 0,
      missing: 0,
      zeroed: 0,
      durationMs: Date.now() - startedAt,
      error: message,
      runBy,
    })
    return { status: 'FAILED', message }
  }
}

/**
 * Picks up a run that ran out of clock. Returns SKIPPED when there is nothing
 * outstanding, which is the normal answer for a cron tick on a quiet day.
 */
export async function continueRun(): Promise<RunOutcome> {
  const startedAt = Date.now()
  const job = await leaseJob()
  if (!job) {
    const existing = await getJob()
    if (existing && (existing.status === 'FETCHING' || existing.status === 'APPLYING')) {
      return { status: 'BUSY', message: 'A stock refresh is already running.' }
    }
    return { status: 'SKIPPED', message: 'Nothing left to apply.' }
  }
  // A run that died before its diff was saved has nothing to resume from; the
  // honest move is to fail it so the next attempt starts cleanly rather than
  // sitting in FETCHING forever.
  if (job.status === 'FETCHING') {
    await finishJob('FAILED', 'The refresh stopped before it had read the file. Try again.')
    return { status: 'FAILED', message: 'The refresh stopped before it had read the file. Try again.' }
  }

  const settings = await getSettings()
  try {
    return await applyRemaining(startedAt, settings.enableTracking)
  } catch (error) {
    const message = describeFailure(error)
    await finishJob('FAILED', message)
    await writeLog({
      trigger: job.trigger,
      status: 'FAILED',
      rowsInFile: job.rowsInFile,
      matched: job.matched,
      updatedCount: job.applied,
      unmatched: job.unmatched,
      missing: job.missing,
      zeroed: job.zeroed,
      durationMs: Date.now() - startedAt,
      error: message,
      runBy: job.runBy,
    })
    return { status: 'FAILED', message }
  }
}

/**
 * Writes batches until the outstanding list is empty or the clock runs out.
 * Progress is saved after every batch, so an unexpected death costs at most one
 * batch of work and never leaves the catalogue half-updated in a way that
 * cannot be resumed.
 */
async function applyRemaining(startedAt: number, enableTracking: boolean): Promise<RunOutcome> {
  let job = await getJob()
  if (!job) return { status: 'SKIPPED', message: 'Nothing left to apply.' }

  let pending = job.pending
  let appliedThisPass = 0

  while (pending.length > 0) {
    if (Date.now() - startedAt > BUDGET_MS) {
      await releaseLease()
      return {
        status: 'PARTIAL',
        message: `Updated ${job.applied + appliedThisPass} so far - ${pending.length} still to go.`,
        applied: job.applied + appliedThisPass,
        remaining: pending.length,
      }
    }
    const batch = pending.slice(0, BATCH_SIZE)
    const written = await applyStockBatch(batch, enableTracking)
    pending = pending.slice(BATCH_SIZE)
    appliedThisPass += written
    await saveBatchProgress(pending, written)
  }

  job = (await getJob()) ?? job
  await finishJob('COMPLETED')
  await writeLog({
    trigger: job.trigger,
    status: 'COMPLETED',
    rowsInFile: job.rowsInFile,
    matched: job.matched,
    updatedCount: job.applied,
    unmatched: job.unmatched,
    missing: job.missing,
    zeroed: job.zeroed,
    durationMs: Date.now() - job.startedAt.getTime(),
    error: job.badValues.length ? `Some stock figures could not be read: ${job.badValues.join('; ')}` : null,
    runBy: job.runBy,
  })
  return {
    status: 'COMPLETED',
    message: summarise(job),
    applied: job.applied,
    remaining: 0,
  }
}

function summarise(job: StkJobRow): string {
  if (job.applied === 0) return 'Stock is already up to date - nothing needed changing.'
  const products = job.applied === 1 ? '1 product' : `${job.applied} products`
  return `Stock updated on ${products}.`
}

/** Turns whatever went wrong into something a shop owner can act on. */
function describeFailure(error: unknown): string {
  if (error instanceof FeedError) return error.message
  if (error instanceof MissingColumnError) return error.message
  if (error instanceof Error) return error.message
  return 'The stock refresh failed for an unknown reason.'
}
