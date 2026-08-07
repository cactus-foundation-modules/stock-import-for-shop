import { getFeedAuth } from '@/modules/stock-import-for-shop/lib/db'
import { assertSafeFeedUrl, FeedError, looksLikeHtml } from '@/modules/stock-import-for-shop/lib/feed-url'

// Downloading the supplier's file, with the guard rails a url typed into a
// settings box needs. The url checks themselves live in feed-url.ts.

export { assertSafeFeedUrl, FeedError } from '@/modules/stock-import-for-shop/lib/feed-url'

/** Refuse a file bigger than this. A stock list is text; 64MB is already absurd. */
const MAX_BYTES = 64 * 1024 * 1024

/** Give up on a supplier that has gone quiet, well inside the route's own ceiling. */
const TIMEOUT_MS = 30_000

export type FeedBody = { text: string; bytes: number }

/**
 * Fetches the feed as text. `maxBytes` lets the Test button pull only the front
 * of a large file - enough to show the headings and a few rows without waiting
 * for the whole thing.
 */
export async function fetchFeed(rawUrl: string, opts?: { maxBytes?: number }): Promise<FeedBody> {
  const url = assertSafeFeedUrl(rawUrl)
  const limit = opts?.maxBytes ?? MAX_BYTES
  const auth = await getFeedAuth()

  const headers: Record<string, string> = {
    // Some supplier portals serve an HTML "please log in" page to anything that
    // does not look like a browser, which then parses as a CSV with one column.
    Accept: 'text/csv, text/plain, */*',
    'User-Agent': 'Cactus Stock Import',
  }
  if (auth) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers,
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FeedError('Your supplier did not answer within thirty seconds.')
    }
    throw new FeedError(`Could not reach that address (${error instanceof Error ? error.message : 'unknown error'}).`)
  }

  try {
    if (response.status === 401 || response.status === 403) {
      throw new FeedError('Your supplier refused the request. If the file needs a username and password, add them below.')
    }
    if (!response.ok) {
      throw new FeedError(`Your supplier answered with an error (HTTP ${response.status}).`)
    }

    const body = response.body
    if (!body) throw new FeedError('Your supplier sent an empty response.')

    // Read with a hard ceiling rather than response.text(), so a mis-typed url
    // pointing at something enormous cannot take the whole function down with it.
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      bytes += value.byteLength
      if (bytes >= limit) {
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
    }
    if (truncated && limit === MAX_BYTES) {
      throw new FeedError('That file is far too big to be a stock list (over 64MB).')
    }

    const text = new TextDecoder('utf-8').decode(concat(chunks, bytes))
    if (!text.trim()) throw new FeedError('That file is empty.')
    if (looksLikeHtml(text)) {
      throw new FeedError('That address returned a web page rather than a stock file. Check the link points straight at the CSV.')
    }
    return { text, bytes }
  } finally {
    clearTimeout(timer)
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > total) {
      out.set(chunk.subarray(0, total - offset), offset)
      break
    }
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
