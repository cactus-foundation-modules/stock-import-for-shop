'use client'

import { useCallback, useEffect, useState } from 'react'
import { FREQUENCY_OPTIONS } from '@/modules/stock-import-for-shop/lib/schedule'
import type { StkLogEntry, StkProbeResult, StkSettings } from '@/modules/stock-import-for-shop/lib/types'

// A sub-tab of shop's settings tab rather than a top-level Settings tab, hosted
// through the 'shop.settings-sub-tabs' slot (manifest `host`). Shop lends the
// space and nothing else: own fetch, own save, own permission, own module API.

const BASE = '/api/m/stock-import-for-shop/admin'
const muted: React.CSSProperties = { color: 'var(--color-text-muted)' }
const hint: React.CSSProperties = { ...muted, fontSize: '0.875rem', marginTop: '0.3rem', display: 'block' }
const field: React.CSSProperties = { marginBottom: '1.25rem' }
const labelText: React.CSSProperties = { display: 'block', marginBottom: '0.35rem', fontWeight: 500 }
const twoUp: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }
const hr: React.CSSProperties = { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1.75rem 0' }
const heading: React.CSSProperties = { margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600 }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : 'never')

function n(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? singular : (plural ?? `${singular}s`)}`
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_COLOUR: Record<StkLogEntry['status'], string> = {
  COMPLETED: 'var(--color-success)',
  FAILED: 'var(--color-error)',
  CANCELLED: 'var(--color-text-muted)',
}

const STATUS_WORD: Record<StkLogEntry['status'], string> = {
  COMPLETED: 'Finished',
  FAILED: 'Failed',
  CANCELLED: 'Stopped',
}

export function StockImportSettingsTab() {
  const [settings, setSettings] = useState<StkSettings | null>(null)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')
  const [probe, setProbe] = useState<StkProbeResult | null>(null)
  const [log, setLog] = useState<StkLogEntry[]>([])

  const loadLog = useCallback(async (): Promise<StkLogEntry[]> => {
    const data = await fetch(`${BASE}/log`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    return Array.isArray(data?.entries) ? data.entries : []
  }, [])

  useEffect(() => {
    let stale = false
    ;(async () => {
      const entries = await loadLog()
      if (!stale) setLog(entries)
    })()
    fetch(`${BASE}/settings`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { settings?: StkSettings }) => {
        if (d.settings) setSettings(d.settings)
      })
      .catch(() => setError('Could not load these settings. Please refresh the page.'))
    return () => {
      stale = true
    }
  }, [loadLog])

  function set<K extends keyof StkSettings>(key: K, value: StkSettings[K]) {
    setSaved(false)
    setSettings((s) => (s ? { ...s, [key]: value } : s))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!settings) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await fetch(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvUrl: settings.csvUrl ?? '',
          skuColumn: settings.skuColumn,
          stockColumn: settings.stockColumn,
          frequencyHours: settings.frequencyHours,
          missingBehaviour: settings.missingBehaviour,
          enableTracking: settings.enableTracking,
          authUser: settings.authUser ?? '',
          // Undefined leaves whatever is stored alone; null clears it.
          ...(clearPassword ? { authPassword: null } : password ? { authPassword: password } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not save these settings.')
      } else {
        if (data.settings) setSettings(data.settings)
        setPassword('')
        setClearPassword(false)
        setSaved(true)
      }
    } catch {
      setError('Could not save these settings.')
    }
    setSaving(false)
  }

  async function test() {
    if (!settings) return
    setTesting(true)
    setTestError('')
    setProbe(null)
    try {
      const res = await fetch(`${BASE}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvUrl: settings.csvUrl ?? '',
          skuColumn: settings.skuColumn,
          stockColumn: settings.stockColumn,
        }),
      })
      const data = await res.json()
      if (!res.ok) setTestError(data.error || 'Could not read that file.')
      else setProbe(data.result)
    } catch {
      setTestError('Could not reach your supplier from here.')
    }
    setTesting(false)
  }

  if (!settings) return <p style={muted}>Loading…</p>

  return (
    <form onSubmit={save}>
      <p style={{ ...muted, marginBottom: '1.5rem' }}>
        Point this at your supplier&rsquo;s stock file and every product whose code appears in it keeps its stock
        count up to date on its own. Nothing else about your products is touched.
      </p>

      <div style={field}>
        <label style={labelText} htmlFor="stk-url">
          Address of the stock file
        </label>
        <input
          id="stk-url"
          type="url"
          className="form-input"
          placeholder="https://example.com/stock.csv"
          value={settings.csvUrl ?? ''}
          onChange={(e) => set('csvUrl', e.target.value)}
          style={{ width: '100%' }}
        />
        <span style={hint}>
          A direct link to a CSV your supplier publishes. If the link opens a download in your browser, it will work
          here.
        </span>
      </div>

      <div style={twoUp}>
        <div style={field}>
          <label style={labelText} htmlFor="stk-sku-col">
            Column with the product code
          </label>
          <input
            id="stk-sku-col"
            type="text"
            className="form-input"
            value={settings.skuColumn}
            onChange={(e) => set('skuColumn', e.target.value)}
            style={{ width: '100%' }}
          />
          <span style={hint}>Matched against each product&rsquo;s SKU. Capital letters and spaces do not matter.</span>
        </div>
        <div style={field}>
          <label style={labelText} htmlFor="stk-stock-col">
            Column with the number in stock
          </label>
          <input
            id="stk-stock-col"
            type="text"
            className="form-input"
            value={settings.stockColumn}
            onChange={(e) => set('stockColumn', e.target.value)}
            style={{ width: '100%' }}
          />
          <span style={hint}>
            Often called FreeStock or Quantity. Pick the one that means &ldquo;available to sell&rdquo;.
          </span>
        </div>
      </div>

      <div style={{ marginBottom: '1.25rem' }}>
        <button type="button" className="btn btn-secondary" onClick={test} disabled={testing || !settings.csvUrl}>
          {testing ? 'Having a look…' : 'Test this file'}
        </button>
        <span style={{ ...muted, fontSize: '0.875rem', marginLeft: '0.75rem' }}>
          Reads the file and reports what it found. Changes nothing.
        </span>
      </div>

      {testError && (
        <div className="alert alert-danger" style={{ marginBottom: '1.25rem' }}>
          {testError}
        </div>
      )}

      {probe && <ProbeReport probe={probe} settings={settings} />}

      <hr style={hr} />

      <h3 style={heading}>When to check</h3>
      <div style={field}>
        <label style={labelText} htmlFor="stk-frequency">
          Check for new figures
        </label>
        <select
          id="stk-frequency"
          className="form-input"
          value={settings.frequencyHours}
          onChange={(e) => set('frequencyHours', Number(e.target.value))}
          style={{ maxWidth: '22rem' }}
        >
          {FREQUENCY_OPTIONS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </select>
        <span style={hint}>
          Last checked: {fmt(settings.lastRunAt)}. There is a <strong>Fetch Latest Stock</strong> button on your
          Products page for when you would rather not wait.
        </span>
      </div>

      <hr style={hr} />

      <h3 style={heading}>What to do with the figures</h3>

      <div style={field}>
        <label style={labelText} htmlFor="stk-missing">
          Products your supplier&rsquo;s file does not mention
        </label>
        <select
          id="stk-missing"
          className="form-input"
          value={settings.missingBehaviour}
          onChange={(e) => set('missingBehaviour', e.target.value === 'ZERO' ? 'ZERO' : 'IGNORE')}
          style={{ maxWidth: '22rem' }}
        >
          <option value="IGNORE">Leave their stock alone</option>
          <option value="ZERO">Treat them as out of stock</option>
        </select>
        <span style={hint}>
          Only choose the second one if this file covers your whole catalogue. If it is one supplier&rsquo;s range,
          it would empty the shelves of everything else.
        </span>
      </div>

      <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer', ...field }}>
        <input
          type="checkbox"
          checked={settings.enableTracking}
          onChange={(e) => set('enableTracking', e.target.checked)}
          style={{ marginTop: '0.2rem' }}
        />
        <span>
          <span style={{ display: 'block', color: 'var(--color-text)' }}>
            Actually hold shoppers to these numbers
          </span>
          <span style={hint}>
            Switches stock tracking on for the products this updates, so the shop stops selling something once it has
            run out. Leave it off and the figures are recorded but never enforced.
          </span>
        </span>
      </label>

      <hr style={hr} />

      <h3 style={heading}>If the file needs a login</h3>
      <p style={{ ...muted, fontSize: '0.875rem', marginTop: '-0.25rem', marginBottom: '1rem' }}>
        Most supplier feeds are open. Fill these in only if yours asks for a username and password.
      </p>
      <div style={twoUp}>
        <div style={field}>
          <label style={labelText} htmlFor="stk-user">
            Username
          </label>
          <input
            id="stk-user"
            type="text"
            className="form-input"
            autoComplete="off"
            value={settings.authUser ?? ''}
            onChange={(e) => set('authUser', e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={field}>
          <label style={labelText} htmlFor="stk-pass">
            Password
          </label>
          <input
            id="stk-pass"
            type="password"
            className="form-input"
            autoComplete="new-password"
            placeholder={settings.hasAuthPassword ? '•••••••• (stored)' : ''}
            value={password}
            disabled={clearPassword}
            onChange={(e) => {
              setSaved(false)
              setPassword(e.target.value)
            }}
            style={{ width: '100%' }}
          />
          {settings.hasAuthPassword && (
            <label style={{ ...hint, display: 'flex', gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) => {
                  setSaved(false)
                  setClearPassword(e.target.checked)
                  if (e.target.checked) setPassword('')
                }}
              />
              Forget the stored password
            </label>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      {saved && !error && <p style={{ ...muted, marginBottom: '1rem' }}>Saved.</p>}

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </button>

      <hr style={hr} />

      <h3 style={heading}>Recent checks</h3>
      {log.length === 0 ? (
        <p style={muted}>Nothing yet. The first check will show up here.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>When</th>
                <th>How</th>
                <th>Result</th>
                <th style={{ textAlign: 'right' }}>Updated</th>
                <th style={{ textAlign: 'right' }}>Matched</th>
                <th style={{ textAlign: 'right' }}>Not in file</th>
              </tr>
            </thead>
            <tbody>
              {log.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(entry.createdAt)}</td>
                  <td>{entry.trigger === 'CRON' ? 'On schedule' : 'By hand'}</td>
                  <td>
                    <span style={{ color: STATUS_COLOUR[entry.status] }}>{STATUS_WORD[entry.status]}</span>
                    {entry.error && (
                      <span style={{ ...hint, marginTop: '0.15rem' }}>{entry.error}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{entry.updatedCount.toLocaleString('en-GB')}</td>
                  <td style={{ textAlign: 'right' }}>{entry.matched.toLocaleString('en-GB')}</td>
                  <td style={{ textAlign: 'right' }}>{entry.missing.toLocaleString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  )
}

// What the Test button found, said plainly. The match count is the number that
// matters: a perfectly valid CSV that shares no codes with the catalogue is the
// commonest way one of these is set up wrong, and it looks like success until
// somebody notices nothing ever changes.
function ProbeReport({ probe, settings }: { probe: StkProbeResult; settings: StkSettings }) {
  const bothFound = probe.skuColumnFound && probe.stockColumnFound
  const tone = !bothFound || probe.matchedSkus === 0 ? 'var(--color-warning)' : 'var(--color-success)'

  return (
    <div
      style={{
        border: `1px solid ${tone}`,
        borderRadius: 'var(--radius-sm)',
        padding: '1rem',
        marginBottom: '1.25rem',
        background: 'var(--color-bg-subtle)',
      }}
    >
      <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>
        Read {n(probe.totalRows, 'row')} ({readableSize(probe.bytes)}).
      </p>

      {!probe.skuColumnFound && (
        <p style={{ color: 'var(--color-error)', margin: '0 0 0.5rem' }}>
          There is no <strong>{settings.skuColumn}</strong> column in this file.
        </p>
      )}
      {!probe.stockColumnFound && (
        <p style={{ color: 'var(--color-error)', margin: '0 0 0.5rem' }}>
          There is no <strong>{settings.stockColumn}</strong> column in this file.
        </p>
      )}

      {bothFound && (
        <p style={{ margin: '0 0 0.5rem' }}>
          {probe.matchedSkus === 0 ? (
            <>
              None of the codes in this file match a product in your shop. Check the product code column is the right
              one.
            </>
          ) : (
            <>
              {n(probe.matchedSkus, 'code')} in this file match a product in your shop.{' '}
              {probe.missingSkus > 0 && (
                <>
                  {n(probe.missingSkus, 'product', 'products')} in your shop {probe.missingSkus === 1 ? 'is' : 'are'}{' '}
                  not mentioned in it.
                </>
              )}
            </>
          )}
        </p>
      )}

      {probe.badValueExamples.length > 0 && (
        <p style={{ ...muted, margin: '0 0 0.5rem', fontSize: '0.875rem' }}>
          Some stock figures could not be read and will be left alone, for example: {probe.badValueExamples.join('; ')}
        </p>
      )}

      <details>
        <summary style={{ cursor: 'pointer', ...muted, fontSize: '0.875rem' }}>Show the first few rows</summary>
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table className="table" style={{ fontSize: '0.8125rem' }}>
            <thead>
              <tr>
                {probe.columns.map((column, index) => (
                  <th key={`${column}-${index}`}>{column || '(no heading)'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {probe.sampleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {probe.columns.map((_, cellIndex) => (
                    <td key={cellIndex} style={{ whiteSpace: 'nowrap' }}>
                      {row[cellIndex] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
