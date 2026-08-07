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

/** One product in the shop whose SKU the supplier's file never mentions. */
export type StkMissingProduct = {
  id: string
  sku: string
  name: string
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  /** The count the shop holds now - the file said nothing, so nothing changed it. */
  stock: number | null
  /** Whether the shop enforces that count at the checkout. */
  tracked: boolean
  /** True for a variation, which is hidden from the catalogue in its own right. */
  hidden: boolean
  /** The listing a variation belongs to. Null when it is a listing itself. */
  parentId: string | null
  parentName: string | null
}

/** The answer to "which of my products is this file not covering?" */
export type StkMissingReport = {
  /** Every product in the shop the file never mentions, counted. */
  total: number
  /** Those products, capped when there are more than a screen can use. */
  products: StkMissingProduct[]
  /** True when `products` is a slice of `total` rather than all of it. */
  truncated: boolean
  /** Data rows read from the file, so the report can say what it compared against. */
  rowsInFile: number
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
