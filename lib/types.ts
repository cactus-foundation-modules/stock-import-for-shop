// Shared shapes for Stock Imports for Shop. Kept in one file so the settings
// tab, the products toolbar and the routes all agree on the wire format without
// any of them importing server code.

export type StkMissingBehaviour = 'IGNORE' | 'ZERO'

export type StkTrigger = 'MANUAL' | 'CRON'

export type StkJobStatus = 'FETCHING' | 'APPLYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type StkSettings = {
  csvUrl: string | null
  skuColumn: string
  stockColumn: string
  /** 0 = automatic runs off; otherwise hours between runs. */
  frequencyHours: number
  missingBehaviour: StkMissingBehaviour
  enableTracking: boolean
  authUser: string | null
  /** Never the password itself - only whether one is stored. */
  hasAuthPassword: boolean
  lastRunAt: string | null
}

/** What the settings tab may change. The password is write-only. */
export type StkSettingsPatch = Partial<
  Omit<StkSettings, 'hasAuthPassword' | 'lastRunAt'> & { authPassword: string | null }
>

export type StkJobStatusPayload = {
  status: StkJobStatus
  trigger: StkTrigger
  rowsInFile: number
  matched: number
  changed: number
  applied: number
  unmatched: number
  missing: number
  zeroed: number
  badValues: string[]
  remaining: number
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** True once nothing further will happen without a new run being started. */
  done: boolean
}

export type StkLogEntry = {
  id: string
  trigger: StkTrigger
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED'
  rowsInFile: number
  matched: number
  updatedCount: number
  unmatched: number
  missing: number
  zeroed: number
  durationMs: number | null
  error: string | null
  createdAt: string
}

/** What a Test fetch reports back about the supplier's file. */
export type StkProbeResult = {
  columns: string[]
  sampleRows: string[][]
  totalRows: number
  /** How many of the file's codes match a SKU already in the shop. */
  matchedSkus: number
  /** How many products in the shop have a SKU the file never mentions. */
  missingSkus: number
  skuColumnFound: boolean
  stockColumnFound: boolean
  /** Rows whose stock cell was not a whole number, capped for display. */
  badValueExamples: string[]
  bytes: number
}
