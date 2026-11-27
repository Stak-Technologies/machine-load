import type { ContainerRow, Group, ProcRow, Section, Snapshot } from '../types'

export type PsRow = {
  pid: number
  ppid: number
  cpuSec: number
  rssKb: number
  isRunnable: boolean
  comm: string
}

export type SessionInfo = {
  pid: number
  name: string
  cwd: string
  procStart: string
}

export type RawInput = {
  at: number
  ps: string
  loadavg: string
  gpu: string
  memory: string
  prevCpuSec: Record<string, number>
  prevAt: number | null
  sessions: SessionInfo[]
  argsByPid: Record<number, string>
  cwdByPid: Record<number, string>
  ageByPid: Record<number, number>
  claudePidByPid: Record<number, number>
  docker: DockerInput | null
  history: { at: number; load: number }[]
}

export type DockerInput = {
  ps: string
  stats: string
  inspect: string
  topById: Record<string, string>
}

const HISTORY_MS = 30 * 60 * 1000
const MAX_HOPS = 64

export function parseCpuTime(text: string): number {
  const [first = '', second] = text.split('-')
  const days = second === undefined ? 0 : Number(first)
  const parts = (second ?? first).split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  const seconds = parts.reverse().reduce((sum, part, i) => sum + part * 60 ** i, 0)

  return days * 86400 + seconds
}

export function parsePs(stdout: string): PsRow[] {
  return stdout
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/))
    .filter(match => match !== null)
    .map(m => ({
      pid: Number(m[1]!),
      ppid: Number(m[2]!),
      cpuSec: parseCpuTime(m[3]!),
      rssKb: Number(m[4]!),
      isRunnable: m[5]!.startsWith('R'),
      comm: m[6]!,
    }))
}

export function parseLoad(stdout: string): { loads: number[]; cores: number } {
  const [loadLine = '', coreLine = ''] = stdout.trim().split('\n')
  const loads = (loadLine.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)

  return { loads, cores: Number(coreLine) || 1 }
}

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// Raw args can carry tokens, so only a fixed label or a script's basename ever leaves this function.
export function describe(comm: string, args: string): string {
  const all = `${comm} ${args}`
  const rules: [RegExp, string][] = [
    [/jest-worker|processChild\.js/, 'Jest test worker'],
    [/\bjest\b/, 'Jest test runner'],
    [/next-server|next\/dist|\bnext dev\b/, 'Next.js dev server'],
    [/ms-playwright|chrome-headless|Chromium/, 'Test browser (Playwright Chromium)'],
    [/playwright/, 'Playwright test runner'],
    [/uvicorn/, 'Python web server (uvicorn/FastAPI)'],
    [/pytest/, 'Python tests (pytest)'],
    [/semgrep/, 'Semgrep code scan'],
    [/\bmypy\b/, 'Python type check (mypy)'],
    [/\btsc\b|typescript\/lib/, 'TypeScript type check'],
    [/eslint/, 'ESLint lint'],
    [/turbopack|webpack/, 'Web bundler (webpack/Turbopack)'],
    [/esbuild/, 'esbuild bundler'],
    [/ffmpeg/, 'Video encoding (ffmpeg)'],
    [/Virtualization\.VirtualMachine|com\.docker/, 'Docker Linux VM (all containers)'],
    [/cloud-firestore-emulator|firestore.*emulator/i, 'Firestore emulator'],
    [/pubsub-emulator/, 'Pub/Sub emulator'],
    [/Google Chrome Helper/, 'Chrome tab or extension'],
    [/Google Chrome/, 'Chrome'],
    [/Claude Helper/, 'Claude app window'],
    [/\/rg$|\brg\b/, 'ripgrep search'],
    [/WindowServer/, 'macOS screen drawing (WindowServer)'],
    [/kernel_task/, 'macOS kernel (often heat throttling)'],
    [/mds_stores|mdworker/, 'Spotlight indexing'],
  ]
  const hit = rules.find(([pattern]) => pattern.test(all))
  if (hit) return hit[1]

  const name = basename(comm)
  if (name === 'claude' || /^\d+\.\d+\.\d+$/.test(name)) return 'Claude Code session'
  if (name === 'node') {
    const script = args.split(/\s+/).find(arg => /\.(c|m)?js$|\.ts$/.test(arg))
    return script ? `Node: ${basename(script)}` : 'Node.js'
  }
  if (/^python/.test(name)) {
    const words = args.split(/\s+/)
    const module = words[words.indexOf('-m') + 1]
    if (words.includes('-m') && module) return `Python: ${module}`
    const script = words.find(arg => arg.endsWith('.py'))
    return script ? `Python: ${basename(script)}` : 'Python'
  }

  return name
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

export function liveSessions(sessions: SessionInfo[], lstartByPid: Record<number, string>) {
  return sessions.filter(s => squash(lstartByPid[s.pid] ?? '') === squash(s.procStart) && s.procStart !== '')
}

export function owningSession(pid: number, parentOf: Map<number, number>, sessionPids: Set<number>) {
  const seen = new Set<number>()
  let current = pid
  for (let hop = 0; hop < MAX_HOPS && current > 1 && !seen.has(current); hop++) {
    if (sessionPids.has(current)) return current
    seen.add(current)
    current = parentOf.get(current) ?? 0
  }

  return null
}

export const ageOf = (text: string) => (/^[\d:.-]+$/.test(text.trim()) ? parseCpuTime(text.trim()) : null)

function toMb(text: string): number {
  const m = text.trim().match(/^([\d.]+)\s*([KMGT]?i?B)/i)
  if (!m) return 0
  const scale: Record<string, number> = { b: 1 / 1048576, kib: 1 / 1024, kb: 1 / 1024, mib: 1, mb: 1, gib: 1024, gb: 1024, tib: 1048576 }

  return Math.round(Number(m[1]) * (scale[m[2]!.toLowerCase()] ?? 1))
}

function imageLabel(image: string): string {
  const name = basename(image.split(':')[0] ?? image)
  const known: Record<string, string> = {
    postgres: 'Postgres database',
    mysql: 'MySQL database',
    mariadb: 'MariaDB database',
    mongo: 'MongoDB database',
    redis: 'Redis cache',
  }
  const ci = name.match(/^(.+)-ci$/)

  return known[name] ?? (ci ? `CI gate (${ci[1]})` : name)
}

// Inside a container the busiest process says which step is running.
export function containerStep(top: string): string | null {
  const rows = top
    .split('\n')
    .slice(1)
    .map(line => line.trim().match(/^(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/))
    .filter(m => m !== null)
    .map(m => ({ cpu: Number(m[2]), args: m[4]! }))
  const busiest = rows.sort((a, b) => b.cpu - a.cpu)[0]
  if (!busiest) return null
  const npm = busiest.args.match(/npm (?:run )?([\w:-]+)/)
  if (npm) return `npm ${npm[1]}`
  const [comm = '', ...rest] = busiest.args.split(/\s+/)

  return describe(comm, rest.join(' '))
}

export function parseContainers(docker: DockerInput, at: number) {
  const stats = new Map(
    docker.stats
      .split('\n')
      .map(line => line.split('|'))
      .filter(parts => parts.length >= 3)
      .map(([id, cpu, mem]) => [id!, { cpu: parseFloat(cpu!) || 0, memMb: toMb(mem!) }]),
  )
  const inspect = docker.inspect
    .split('\n')
    .map(line => line.split('|'))
    .filter(parts => parts.length >= 3)
    .map(([id, started, env]) => {
      const vars = Object.fromEntries((env ?? '').split(';').filter(Boolean).map(kv => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]))
      return { id: id!, startedAt: Date.parse(started!), sha: vars.CI_SHA || null, branch: vars.CI_BRANCH || null }
    })

  return docker.ps
    .split('\n')
    .map(line => line.split('|'))
    .filter(parts => parts.length >= 3)
    .map(([id, name, image, workdir]) => {
      const meta = inspect.find(x => x.id.startsWith(id!))
      const use = stats.get(id!) ?? { cpu: 0, memMb: 0 }
      return {
        id: id!,
        name: name!,
        image: image!,
        label: imageLabel(image!),
        workdir: workdir || null,
        sha: meta?.sha ?? null,
        branch: meta?.branch ?? null,
        ageSec: meta && !Number.isNaN(meta.startedAt) ? Math.max(0, Math.round((at - meta.startedAt) / 1000)) : null,
        step: containerStep(docker.topById[id!] ?? ''),
        ...use,
      }
    })
}

export function buildSnapshot(input: RawInput, topCount = 30): { snapshot: Snapshot; cpuSec: Record<string, number> } {
  const rows = parsePs(input.ps)
  const { loads, cores } = parseLoad(input.loadavg)
  const dtSec = input.prevAt === null ? 0 : (input.at - input.prevAt) / 1000
  const cpuSec: Record<string, number> = {}
  for (const row of rows) cpuSec[row.pid] = row.cpuSec

  const cpuOf = (row: PsRow) => {
    const before = input.prevCpuSec[row.pid]
    if (dtSec <= 0 || before === undefined) return 0
    return Math.max(0, ((row.cpuSec - before) / dtSec) * 100)
  }

  const scored = rows.map(row => ({ row, cpu: cpuOf(row) }))
  const totalCpu = scored.reduce((sum, s) => sum + s.cpu, 0)
  const top = scored.filter(s => s.cpu >= 0.5).sort((a, b) => b.cpu - a.cpu).slice(0, topCount)

  const parentOf = new Map(rows.map(r => [r.pid, r.ppid]))
  const sessionByPid = new Map(input.sessions.map(s => [s.pid, s]))
  const sessionPids = new Set(sessionByPid.keys())
  const groups = new Map<string, Group & { section: Section['key'] }>()
  const groupFor = (section: Section['key'], key: string, title: string) => {
    const group = groups.get(key) ?? { section, key, title, cpu: 0, procs: [], containers: [] }
    groups.set(key, group)
    return group
  }

  const ownerOf = (pid: number) => {
    const cwd = input.cwdByPid[pid] ?? null
    // A job whose shell was let go of is re-parented to launchd, but it still carries the CLAUDE_PID it was started under.
    const owner = owningSession(pid, parentOf, sessionPids) ?? input.claudePidByPid[pid] ?? null
    const session = owner !== null ? sessionByPid.get(owner) : undefined
    if (session) return { section: 'sessions' as const, key: `s${session.pid}`, title: session.name || basename(session.cwd) }
    return ownerByFolder(cwd)
  }
  const ownerByFolder = (cwd: string | null) => {
    const byFolder = cwd ? input.sessions.filter(s => cwd === s.cwd || cwd.startsWith(`${s.cwd}/`)) : []
    const only = byFolder.length === 1 ? byFolder[0] : undefined
    if (only) return { section: 'sessions' as const, key: `s${only.pid}`, title: only.name || basename(only.cwd) }
    // Mac apps run from their sandbox folder under Library, which is not anyone's project work.
    if (cwd && cwd !== '/' && !cwd.includes('/Library/')) return { section: 'detached' as const, key: `f${cwd}`, title: basename(cwd) }
    return { section: 'system' as const, key: 'system', title: 'Mac apps and system' }
  }

  const containers = input.docker ? parseContainers(input.docker, input.at) : []
  const containerRows: ContainerRow[] = containers.map(c => {
    const clients = rows.filter(r => /docker|com\.docker\.cli/.test(basename(r.comm)) && (input.argsByPid[r.pid] ?? '').includes(' run '))
    // A CI_SHA passed to `docker run` pins the exact client; otherwise a client running the same image counts only when it is the one.
    const bySha = c.sha ? clients.find(r => (input.argsByPid[r.pid] ?? '').includes(`CI_SHA=${c.sha}`)) : undefined
    const byImage = clients.filter(r => (input.argsByPid[r.pid] ?? '').split(/\s+/).includes(c.image))
    const runner = bySha ?? (byImage.length === 1 ? byImage[0] : undefined)
    const owner = runner ? ownerOf(runner.pid) : c.workdir ? ownerByFolder(c.workdir) : null
    const row: ContainerRow = {
      key: `c${c.id}`,
      label: c.label,
      branch: c.branch,
      step: c.step,
      cpu: c.cpu,
      memMb: c.memMb,
      ageSec: c.ageSec,
      owner: owner && owner.section !== 'system' ? owner.title : null,
      folder: runner ? basename(input.cwdByPid[runner.pid] ?? '') || null : c.workdir ? basename(c.workdir) : null,
    }
    if (owner && owner.section !== 'system') {
      const group = groupFor(owner.section, owner.key, owner.title)
      group.containers.push(row)
      group.cpu += row.cpu
    }
    return row
  })

  for (const { row, cpu } of top) {
    const cwd = input.cwdByPid[row.pid] ?? null
    const label = describe(row.comm, input.argsByPid[row.pid] ?? '')
    const proc: ProcRow = {
      key: `p${row.pid}`,
      pid: row.pid,
      label,
      folder: cwd && cwd !== '/' ? basename(cwd) : null,
      cpu,
      memMb: Math.round(row.rssKb / 1024),
      ageSec: input.ageByPid[row.pid] ?? null,
      containers: label === 'Docker Linux VM (all containers)' ? containerRows : [],
    }
    const owner = ownerOf(row.pid)
    const group = groupFor(owner.section, owner.key, owner.title)
    group.procs.push(proc)
    group.cpu += cpu
  }

  const titles: Record<Section['key'], string> = {
    sessions: 'Claude sessions',
    detached: 'Detached jobs (their session ended or let go of them)',
    system: 'Mac apps and system',
  }
  const sections: Section[] = (['sessions', 'detached', 'system'] as const)
    .map(key => {
      const inside = [...groups.values()].filter(g => g.section === key).map(({ section: _, ...g }) => g)
      return { key, title: titles[key], cpu: inside.reduce((sum, g) => sum + g.cpu, 0), groups: inside }
    })
    .filter(section => section.groups.length > 0)

  const gpu = input.gpu.match(/"Device Utilization %"\s*=\s*(\d+)/)
  const mem = input.memory.match(/free percentage:\s*(\d+)%/)
  const load1 = loads[0] ?? 0
  const history = [...input.history, { at: input.at, load: load1 }].filter(h => h.at > input.at - HISTORY_MS)

  return {
    cpuSec,
    snapshot: {
      at: input.at,
      load1,
      load5: loads[1] ?? 0,
      load15: loads[2] ?? 0,
      cores,
      cpuPct: dtSec > 0 ? Math.min(100, totalCpu / cores) : null,
      gpuPct: gpu ? Number(gpu[1]) : null,
      memFreePct: mem ? Number(mem[1]) : null,
      runnable: rows.filter(r => r.isRunnable).length,
      sections,
      history,
    },
  }
}


export function formatAge(sec: number | null): string {
  if (sec === null) return ''
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h ${min % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

// "billing api" finds "billing-api-worktree": spaces, dashes and case are ignored.
export function matches(query: string, ...texts: (string | null)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).map(fold).filter(Boolean)
  const hay = fold(texts.filter(Boolean).join(' '))

  return words.length === 0 || words.every(word => hay.includes(word)) || hay.includes(words.join(''))
}

// Rows keep the place they had so the list stays still between samples; a resort (header click) re-sorts all.
export function arrange<T>(previous: string[] | undefined, items: T[], keyOf: (item: T) => string, compare: (a: T, b: T) => number, isResort: boolean): T[] {
  const sorted = [...items].sort(compare)
  if (isResort || !previous) return sorted
  const place = new Map(previous.map((key, i) => [key, i]))
  const kept = items.filter(item => place.has(keyOf(item))).sort((a, b) => place.get(keyOf(a))! - place.get(keyOf(b))!)
  const added = sorted.filter(item => !place.has(keyOf(item)))

  return [...kept, ...added]
}

export function verdict(load: number, cores: number): { word: string; tone: 'success' | 'warning' | 'error' } {
  const ratio = load / cores
  if (ratio < 0.7) return { word: 'Calm', tone: 'success' }
  if (ratio < 1.5) return { word: 'Busy', tone: 'warning' }
  return { word: 'Overloaded', tone: 'error' }
}

export function explain(load: number, cores: number): string {
  const rounded = Math.round(load)
  if (load <= cores) {
    return `On average ${rounded} tasks wanted the processor at the same moment over the last minute. Your Mac has ${cores} cores, so nothing had to wait.`
  }
  const times = (load / cores).toFixed(load / cores >= 10 ? 0 : 1)

  return `On average ${rounded} tasks wanted the processor at the same moment over the last minute, but your Mac has ${cores} cores. That is ${times}× more than it can run at once, so tasks queue and everything runs slower.`
}
