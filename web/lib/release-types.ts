// Shapes mirrored from `belz release matrix` output (integrations/release).
// The web UI reads these straight from the promotion ledger JSON files.

export type TicketKind = "included" | "excluded"
export type ItemKind = TicketKind | "both"
export type Leak = "leaked" | "clean" | "unknown"

export interface TicketRow {
  id: number
  name: string
  kind: TicketKind
  ad: string[]
  pd: string[]
  error?: string
}

export interface ItemEnvCell {
  env: string
  status: string
  spinePos: number
  spineVersion: number | null
}

export interface ItemRow {
  uuid: string
  name: string
  category: string
  kind: ItemKind
  tickets: number[]
  spineLen: number
  envs: ItemEnvCell[]
  error?: string
}

export interface Collision {
  uuid: string
  name: string
  includedTickets: number[]
  excludedTickets: number[]
  leak: Leak
  detail: string
}

export interface MatrixData {
  name: string
  generatedAt: string
  spineEnv: string
  stageEnv: string
  tickets: TicketRow[]
  items: ItemRow[]
  collisions: Collision[]
  pdNote: string
  warnings: string[]
}

export interface ReleaseSummary {
  name: string
  generatedAt: string
  ticketCount: number
  itemCount: number
  collisionCount: number
  leakedCount: number
}
