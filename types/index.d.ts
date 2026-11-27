export type ContainerRow = {
  key: string
  label: string
  branch: string | null
  step: string | null
  cpu: number
  memMb: number
  ageSec: number | null
  owner: string | null
  folder: string | null
}

export type ProcRow = {
  key: string
  pid: number
  label: string
  folder: string | null
  cpu: number
  memMb: number
  ageSec: number | null
  containers: ContainerRow[]
}

export type Group = {
  key: string
  title: string
  cpu: number
  procs: ProcRow[]
  containers: ContainerRow[]
}

export type Section = {
  key: 'sessions' | 'detached' | 'system'
  title: string
  cpu: number
  groups: Group[]
}

export type Snapshot = {
  at: number
  load1: number
  load5: number
  load15: number
  cores: number
  cpuPct: number | null
  gpuPct: number | null
  memFreePct: number | null
  runnable: number
  sections: Section[]
  history: { at: number; load: number }[]
}

export type SortColumn = 'name' | 'age' | 'cpu' | 'mem'

export type View = {
  sort: { column: SortColumn; isDescending: boolean }
  collapsed: string[]
  expanded: string[]
  query: string
  resorts: number
}

declare module 'claude-code' {
  interface PluginState {
    'machine-load': { snapshot: Shaped<Snapshot | null>; isDetailsOpen: boolean; isDemo: boolean; view: View }
  }
}
