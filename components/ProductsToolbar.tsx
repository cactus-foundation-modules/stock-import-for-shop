'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { StkJobStatusPayload } from '@/modules/stock-import-for-shop/lib/types'

// The Fetch Latest Stock button, injected onto shop's Products page through the
// `shop.products-toolbar` extension point. Setup itself lives on
// Settings > Shop > Stock; this is only the "do it now" handle.
//
// A first import over a large catalogue does not fit in one request, so the
// button starts the run and then keeps calling /run/step until the job says it
// is finished. All the owner sees is a progress line.

const BASE = '/api/m/stock-import-for-shop/admin'
const muted: React.CSSProperties = { color: 'var(--color-text-muted)' }

type Outcome = { status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'BUSY' | 'SKIPPED'; message: string }

// A failed response carries { error } whenever the route itself answered. It
// does not when the platform answers over the route's head - a 504 at the
// sixty-second ceiling, or a crash before any handler ran - and the fallback
// text alone then reads as a verdict on the supplier's file, which it is not.
function failureText(res: Response, body: { error?: unknown }, fallback: string): string {
  if (typeof body.error === 'string' && body.error) return body.error
  if (res.status === 504) return `${fallback} It ran out of time before your site answered.`
  return `${fallback} Your site answered with an error (HTTP ${res.status}) rather than a reason.`
}

function n(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? singular : (plural ?? `${singular}s`)}`
}

export function StockImportProductsToolbar() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<StkJobStatusPayload | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Set when the component goes away mid-run, so the stepping loop stops rather
  // than firing requests at an unmounted screen.
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  // One call answers both questions: whether a stock file has been set up at
  // all, and whether something is already part-way through applying one.
  const loadStatus = useCallback(async (): Promise<{
    configured: boolean
    running: boolean
    status: StkJobStatusPayload | null
  }> => {
    const data = await fetch(`${BASE}/run/status`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (!data) return { configured: false, running: false, status: null }
    const existing: StkJobStatusPayload | null = data.status ?? null
    const running = !!existing && !existing.done
    return { configured: !!data.configured, running, status: running ? existing : null }
  }, [])

  useEffect(() => {
    let stale = false
    ;(async () => {
      const seen = await loadStatus()
      if (stale) return
      setConfigured(seen.configured)
      if (seen.running) setMessage('A stock refresh is already under way. It will carry on by itself.')
      if (seen.status) setStatus(seen.status)
    })()
    return () => {
      stale = true
    }
  }, [loadStatus])

  // Clear a finished message after a while, but never an error - an error is
  // the one thing the owner needs to still be there when they look back.
  useEffect(() => {
    if (!message || failed) return
    const timer = setTimeout(() => setMessage(null), 12_000)
    return () => clearTimeout(timer)
  }, [message, failed])

  async function step(url: string): Promise<{ outcome: Outcome; status: StkJobStatusPayload | null }> {
    const res = await fetch(url, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(failureText(res, body, "Couldn't fetch the latest stock."))
    }
    return body
  }

  async function run() {
    setRunning(true)
    setFailed(false)
    setMessage(null)
    try {
      let result = await step(`${BASE}/run`)
      setStatus(result.status)

      // Keep going while the run has more to apply. The guard on `remaining`
      // as well as `done` means a job that somehow stops making progress ends
      // the loop rather than spinning against the server forever.
      let guard = 0
      while (
        !cancelled.current &&
        result.outcome.status === 'PARTIAL' &&
        result.status &&
        !result.status.done &&
        guard < 200
      ) {
        guard++
        result = await step(`${BASE}/run/step`)
        setStatus(result.status)
      }

      if (cancelled.current) return
      setFailed(result.outcome.status === 'FAILED')
      if (result.outcome.status === 'PARTIAL') {
        setMessage('Still working through it. It will carry on by itself - come back in a few minutes.')
      } else {
        setMessage(result.outcome.message)
      }
    } catch (error) {
      if (cancelled.current) return
      setFailed(true)
      setMessage(error instanceof Error ? error.message : "Couldn't fetch the latest stock.")
    } finally {
      if (!cancelled.current) setRunning(false)
    }
  }

  // Nothing to offer until a stock file has been set up. Settings > Shop > Stock
  // is where that happens, and a button that can only ever fail is not a hint.
  if (configured !== true) return null

  // Only this press disables the button. A run the schedule started elsewhere is
  // reported, not enforced: pressing during one gets a plain "already running",
  // and a run whose request died leaves the button usable rather than stuck.
  const busy = running

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={run} disabled={busy}>
        {busy ? 'Fetching stock…' : 'Fetch Latest Stock'}
      </button>

      {(message || (busy && status)) && (
        <div
          className="card"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 0.25rem)',
            zIndex: 40,
            minWidth: '20rem',
            fontSize: '0.8125rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          {busy && status ? (
            <>
              <div style={{ marginBottom: '0.4rem' }}>
                {status.status === 'FETCHING'
                  ? 'Reading your supplier’s file…'
                  : `Updating stock - ${n(status.applied, 'product')} done, ${status.remaining.toLocaleString('en-GB')} to go.`}
              </div>
              <div style={{ height: '0.4rem', background: 'var(--color-bg-subtle)', borderRadius: '999px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: progressWidth(status),
                    height: '100%',
                    background: 'var(--color-primary)',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </>
          ) : (
            <div style={failed ? { color: 'var(--color-error)' } : undefined}>{message}</div>
          )}
          {!busy && !failed && status && status.status === 'COMPLETED' && (
            <div style={{ ...muted, marginTop: '0.35rem' }}>
              {n(status.matched, 'code')} matched, {status.unmatched.toLocaleString('en-GB')} not in your shop,{' '}
              {status.missing.toLocaleString('en-GB')} of your products not in the file.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function progressWidth(status: StkJobStatusPayload): string {
  const total = status.applied + status.remaining
  if (total <= 0) return status.status === 'FETCHING' ? '10%' : '100%'
  return `${Math.min(100, Math.round((status.applied / total) * 100))}%`
}
