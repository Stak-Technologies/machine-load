import type { ContainerRow, ProcRow, Snapshot } from '../types'

const AT = Date.UTC(2026, 0, 15, 15, 0, 0)

const proc = (key: string, label: string, cpu: number, memMb: number, ageSec: number, folder: string | null = null): ProcRow => ({
  key,
  pid: 0,
  label,
  folder,
  cpu,
  memMb,
  ageSec,
  containers: [],
})

const gate: ContainerRow = {
  key: 'c-gate',
  label: 'CI gate (acme-backend)',
  branch: 'feature/invoice-export',
  step: 'Python tests (pytest)',
  cpu: 212,
  memMb: 6400,
  ageSec: 1260,
  owner: 'Billing API: invoice export',
  folder: 'acme-backend-invoices',
}
const db: ContainerRow = {
  key: 'c-db',
  label: 'Postgres database',
  branch: null,
  step: 'postgres',
  cpu: 4,
  memMb: 180,
  ageSec: 86400 * 2,
  owner: 'Mobile release 2.4',
  folder: 'acme-mobile',
}

// Made-up sessions for screenshots and demos, so no real work is ever shown.
export const DEMO_SNAPSHOT: Snapshot = {
  at: AT,
  load1: 27.4,
  load5: 21.8,
  load15: 14.2,
  cores: 10,
  cpuPct: 78,
  gpuPct: 12,
  memFreePct: 31,
  runnable: 64,
  history: Array.from({ length: 180 }, (_, i) => ({
    at: AT - (179 - i) * 10_000,
    load: Math.max(2, 6 + i * 0.12 + 6 * Math.sin(i / 9) + (i > 140 ? (i - 140) * 0.35 : 0)),
  })),
  sections: [
    {
      key: 'sessions',
      title: 'Claude sessions',
      cpu: 731,
      groups: [
        {
          key: 's-billing',
          title: 'Billing API: invoice export',
          cpu: 512,
          procs: [proc('p1', 'Jest test worker', 148, 1900, 310, 'acme-web-invoices'), proc('p2', 'Jest test worker', 121, 1750, 310, 'acme-web-invoices'), proc('p3', 'Next.js dev server', 31, 1200, 5400, 'acme-web-invoices')],
          containers: [gate],
        },
        {
          key: 's-mobile',
          title: 'Mobile release 2.4',
          cpu: 196,
          procs: [proc('p4', 'Test browser (Playwright Chromium)', 104, 880, 95, 'acme-mobile'), proc('p5', 'Playwright test runner', 88, 420, 96, 'acme-mobile')],
          containers: [db],
        },
        {
          key: 's-docs',
          title: 'Docs site refresh',
          cpu: 23,
          procs: [proc('p6', 'Node: build-docs.js', 23, 310, 40, 'acme-docs')],
          containers: [],
        },
      ],
    },
    {
      key: 'detached',
      title: 'Detached jobs (their session ended or let go of them)',
      cpu: 64,
      groups: [
        {
          key: 'f-old',
          title: 'acme-web-spike',
          cpu: 64,
          procs: [proc('p7', 'Next.js dev server', 64, 2300, 64800, 'acme-web-spike')],
          containers: [],
        },
      ],
    },
    {
      key: 'system',
      title: 'Mac apps and system',
      cpu: 260,
      groups: [
        {
          key: 'system',
          title: 'Mac apps and system',
          cpu: 260,
          procs: [
            { ...proc('p8', 'Docker Linux VM (all containers)', 221, 9100, 86400 * 2), containers: [gate, db] },
            proc('p9', 'macOS screen drawing (WindowServer)', 22, 140, 86400 * 9),
            proc('p10', 'Spotlight indexing', 17, 90, 3600),
          ],
          containers: [],
        },
      ],
    },
  ],
}
