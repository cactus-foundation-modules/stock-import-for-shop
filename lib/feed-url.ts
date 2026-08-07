// The checks that decide whether an owner-typed address may be fetched at all.
// Kept apart from the fetching itself so they carry no database import and can
// be tested as the plain functions they are.

export class FeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedError'
  }
}

/**
 * Only http(s), and never a private address.
 *
 * The url is owner-supplied and the request is made by the site's own server -
 * which can reach things the owner's browser cannot, including the metadata
 * endpoints and internal services of whatever it is deployed on. A typo is the
 * likeliest reason one of those would ever appear here, but the check is not
 * optional either way.
 */
export function assertSafeFeedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new FeedError('That does not look like a web address. It should start with https://')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FeedError('The address has to start with https:// or http://')
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (isPrivateHost(host)) {
    throw new FeedError('That address points back at this server rather than out at your supplier.')
  }
  return url
}

export function isPrivateHost(host: string): boolean {
  return (
    host === '' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host)
  )
}

/** A login page dressed as a download is the single most common false success. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 400).trim().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')
}
