import { describe, it, expect } from 'vitest'
import { assertSafeFeedUrl, FeedError, looksLikeHtml } from '@/modules/stock-import-for-shop/lib/feed-url'

describe('assertSafeFeedUrl', () => {
  it('accepts an ordinary supplier address', () => {
    expect(assertSafeFeedUrl('https://edi.example.co.uk/Uploads/178/STK.csv').hostname).toBe('edi.example.co.uk')
  })

  it('accepts plain http, since plenty of supplier portals are still on it', () => {
    expect(assertSafeFeedUrl('http://edi.example.co.uk/stock.csv').protocol).toBe('http:')
  })

  it('trims surrounding whitespace from a pasted address', () => {
    expect(assertSafeFeedUrl('  https://example.com/s.csv  ').pathname).toBe('/s.csv')
  })

  it('rejects anything that is not a web address', () => {
    expect(() => assertSafeFeedUrl('stock.csv')).toThrow(FeedError)
    expect(() => assertSafeFeedUrl('')).toThrow(FeedError)
  })

  it('rejects other schemes', () => {
    expect(() => assertSafeFeedUrl('file:///etc/passwd')).toThrow(FeedError)
    expect(() => assertSafeFeedUrl('ftp://example.com/stock.csv')).toThrow(FeedError)
  })

  it('refuses addresses that point back at the site itself', () => {
    for (const url of [
      'http://localhost:3000/stock.csv',
      'http://127.0.0.1/stock.csv',
      'http://10.0.0.4/stock.csv',
      'http://192.168.1.20/stock.csv',
      'http://172.16.4.4/stock.csv',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/stock.csv',
      'http://db.internal/stock.csv',
      'http://printer.local/stock.csv',
    ]) {
      expect(() => assertSafeFeedUrl(url), url).toThrow(FeedError)
    }
  })

  it('does not mistake a public address that merely starts with a similar number', () => {
    expect(assertSafeFeedUrl('http://172.32.0.1/stock.csv').hostname).toBe('172.32.0.1')
    expect(assertSafeFeedUrl('http://11.0.0.1/stock.csv').hostname).toBe('11.0.0.1')
  })
})

describe('looksLikeHtml', () => {
  it('spots a login page served in place of the file', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><body>Please sign in')).toBe(true)
    expect(looksLikeHtml('  <html lang="en">')).toBe(true)
    expect(looksLikeHtml('<?xml version="1.0"?>')).toBe(true)
  })

  it('leaves an actual CSV alone', () => {
    expect(looksLikeHtml('ProductCode,FreeStock\nAC1,3\n')).toBe(false)
  })
})
