import { describe, it, expect } from 'vitest'
import { isRunDue, isValidFrequency, nextRunAt, frequencyLabel } from '@/modules/stock-import-for-shop/lib/schedule'

const HOUR = 60 * 60 * 1000
const now = new Date('2026-08-07T12:00:00.000Z')

describe('isRunDue', () => {
  it('never runs when automatic refresh is switched off', () => {
    expect(isRunDue(0, null, now)).toBe(false)
    expect(isRunDue(0, new Date('2020-01-01T00:00:00.000Z'), now)).toBe(false)
  })

  it('runs immediately the first time', () => {
    expect(isRunDue(24, null, now)).toBe(true)
  })

  it('waits until the interval has passed', () => {
    expect(isRunDue(6, new Date(now.getTime() - 2 * HOUR), now)).toBe(false)
    expect(isRunDue(6, new Date(now.getTime() - 6 * HOUR), now)).toBe(true)
  })

  it('tolerates a cron tick that lands a few minutes early, so a daily run does not drift', () => {
    // 23h 55m since the last run: strict arithmetic would say no and push the
    // whole schedule an hour later every day.
    expect(isRunDue(24, new Date(now.getTime() - 24 * HOUR + 5 * 60 * 1000), now)).toBe(true)
  })

  it('does not treat a tick half an interval early as due', () => {
    expect(isRunDue(24, new Date(now.getTime() - 12 * HOUR), now)).toBe(false)
  })

  it('recovers from a last-run stamp in the future', () => {
    expect(isRunDue(24, new Date(now.getTime() + 5 * HOUR), now)).toBe(true)
  })
})

describe('isValidFrequency', () => {
  it('accepts the offered choices', () => {
    expect(isValidFrequency(0)).toBe(true)
    expect(isValidFrequency(24)).toBe(true)
    expect(isValidFrequency(168)).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isValidFrequency(5)).toBe(false)
    expect(isValidFrequency(-1)).toBe(false)
    expect(isValidFrequency(1000)).toBe(false)
  })
})

describe('nextRunAt', () => {
  it('is null when off or never run', () => {
    expect(nextRunAt(0, now)).toBeNull()
    expect(nextRunAt(24, null)).toBeNull()
  })
  it('is one interval after the last run', () => {
    expect(nextRunAt(6, now)?.toISOString()).toBe('2026-08-07T18:00:00.000Z')
  })
})

describe('frequencyLabel', () => {
  it('names the offered choices in plain English', () => {
    expect(frequencyLabel(0)).toBe('Only when I press the button')
    expect(frequencyLabel(24)).toBe('Once a day')
  })
})
