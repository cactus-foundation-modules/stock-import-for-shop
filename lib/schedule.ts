// How often the automatic refresh actually runs.
//
// Vercel Cron schedules are baked into the deployment, so the frequency the
// owner picks in Settings cannot be one. The module registers a single hourly
// cron and that hourly tick asks this: given how long the owner asked for and
// when we last ran, is it time yet?
//
// The tolerance matters. A cron tick never lands on the same second twice, so
// comparing "hours since last run >= frequency" exactly would make a 24-hour
// schedule slip forwards by a minute or two every day until it had wandered
// through an entire hour and started skipping days. Ten minutes of slack keeps
// a daily run on the same hour indefinitely.
const TOLERANCE_MS = 10 * 60 * 1000

/** The choices offered in Settings. 0 is "off - only the button". */
export const FREQUENCY_OPTIONS: { hours: number; label: string }[] = [
  { hours: 0, label: 'Only when I press the button' },
  { hours: 1, label: 'Every hour' },
  { hours: 2, label: 'Every 2 hours' },
  { hours: 3, label: 'Every 3 hours' },
  { hours: 4, label: 'Every 4 hours' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 8, label: 'Every 8 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Once a day' },
  { hours: 48, label: 'Every 2 days' },
  { hours: 168, label: 'Once a week' },
]

export function isValidFrequency(hours: number): boolean {
  return FREQUENCY_OPTIONS.some((o) => o.hours === hours)
}

export function frequencyLabel(hours: number): string {
  return FREQUENCY_OPTIONS.find((o) => o.hours === hours)?.label ?? `Every ${hours} hours`
}

/**
 * Whether the hourly cron tick should start a run.
 *
 * Never ran before and switched on: yes, straight away - waiting a full cycle
 * before the first refresh would look broken.
 */
export function isRunDue(frequencyHours: number, lastRunAt: Date | null, now: Date): boolean {
  if (frequencyHours <= 0) return false
  if (!lastRunAt) return true
  const elapsed = now.getTime() - lastRunAt.getTime()
  // A last-run stamp in the future (clock skew, or a restored backup) must not
  // wedge the schedule shut forever.
  if (elapsed < 0) return true
  return elapsed >= frequencyHours * 60 * 60 * 1000 - TOLERANCE_MS
}

/** When the next automatic run is expected, for the settings tab to show. */
export function nextRunAt(frequencyHours: number, lastRunAt: Date | null): Date | null {
  if (frequencyHours <= 0) return null
  if (!lastRunAt) return null
  return new Date(lastRunAt.getTime() + frequencyHours * 60 * 60 * 1000)
}
