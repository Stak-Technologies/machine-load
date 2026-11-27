import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Snapshot } from '../types'
import { ageOf, buildSnapshot, explain, liveSessions, parsePs, verdict } from './sample'
import type { DockerInput, SessionInfo } from './sample'
import { details } from './details'
import { DEFAULT_VIEW, openSorted } from './state'

const PLUGIN = 'machine-load'
const PANE = 'machine-load'
const TICK_MS = 10_000
// The tag declines a snapshot an earlier version stored in another shape; change it when Snapshot changes.
const snapshot = atom({ plugin: 'machine-load', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const view = atom({ plugin: 'machine-load', key: 'view' } as const, DEFAULT_VIEW)
const isDetailsOpen = atom({ plugin: 'machine-load', key: 'isDetailsOpen' } as const, false)

type Shared = { snapshot: Snapshot; cpuSec: Record<string, number> }

const formatLoad = (load: number) => (load >= 100 ? load.toFixed(0) : load.toFixed(1))
const pct = (value: number | null) => (value === null ? '…' : `${Math.round(value)}%`)

let home = ''
let isTicking = false

async function run($: Engine, argv: string[]) {
  try {
    return (await $.process.run(argv, { timeoutMs: 8000 })).stdout
  } catch {
    return ''
  }
}

// Every open session runs this mod, so one shared file lets a single session sample for all of them.
async function tick($: Engine) {
  if (isTicking) return
  isTicking = true
  try {
    home ||= await run($, ['sh', '-c', 'printf %s "$HOME"'])
    const file = `${home}/.claude/state/machine-load.json`
    const at = await $.clock.now()
    let shared: Shared | null = null
    try {
      shared = JSON.parse(await $.fs.read(file)) as Shared
    } catch {
      shared = null
    }
    if (shared && !Array.isArray(shared.snapshot?.sections)) shared = null
    if (shared && at - shared.snapshot.at < TICK_MS - 1000) {
      await update($, snapshot, () => shared!.snapshot)
      return
    }

    const [ps, loadavg, gpu, memory, sessionText] = await Promise.all([
      run($, ['ps', '-Ao', 'pid=,ppid=,time=,rss=,state=,comm=']),
      run($, ['sysctl', '-n', 'vm.loadavg', 'hw.ncpu']),
      run($, ['ioreg', '-r', '-d', '1', '-c', 'IOAccelerator']),
      run($, ['memory_pressure', '-Q']),
      run($, ['sh', '-c', 'for f in "$HOME"/.claude/sessions/*.json; do tr -d "\\n" < "$f"; echo; done']),
    ])

    const sessions: SessionInfo[] = sessionText
      .split('\n')
      .flatMap(line => {
        try {
          const s = JSON.parse(line)
          return typeof s.pid === 'number' ? [{ pid: s.pid, name: s.name ?? '', cwd: s.cwd ?? '', procStart: s.procStart ?? '' }] : []
        } catch {
          return []
        }
      })
    const lstartByPid: Record<number, string> = {}
    if (sessions.length > 0) {
      const lstart = await run($, ['env', 'TZ=UTC', 'ps', '-o', 'pid=,lstart=', '-p', sessions.map(s => s.pid).join(',')])
      for (const line of lstart.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/)
        if (m) lstartByPid[Number(m[1])] = m[2]!
      }
    }

    const base = {
      at,
      ps,
      loadavg,
      gpu,
      memory,
      prevCpuSec: shared?.cpuSec ?? {},
      prevAt: shared?.snapshot.at ?? null,
      sessions: liveSessions(sessions, lstartByPid),
      argsByPid: {} as Record<number, string>,
      cwdByPid: {} as Record<number, string>,
      ageByPid: {} as Record<number, number>,
      claudePidByPid: {} as Record<number, number>,
      docker: await readDocker($),
      history: shared?.snapshot.history ?? [],
    }
    // The host's `docker run` clients tie each container back to the session that started it.
    const dockerClients = base.docker ? parsePs(ps).filter(r => /(^|\/)(docker|com\.docker\.cli)$/.test(r.comm)).map(r => r.pid) : []
    const topPids = buildSnapshot(base).snapshot.sections.flatMap(s => s.groups.flatMap(g => g.procs.map(p => p.pid)))
    if (topPids.length + dockerClients.length > 0) {
      const list = [...topPids, ...dockerClients].join(',')
      const [args, cwds, envs] = await Promise.all([
        run($, ['ps', '-o', 'pid=,etime=,args=', '-p', list]),
        run($, ['lsof', '-a', '-d', 'cwd', '-Fn', '-p', list]),
        run($, ['ps', '-E', '-ww', '-o', 'pid=,command=', '-p', list]),
      ])
      // The environment can hold secrets: only CLAUDE_PID is taken from it, and the rest is dropped here.
      for (const line of envs.split('\n')) {
        const m = line.trim().match(/^(\d+)\s.*\bCLAUDE_PID=(\d+)\b/)
        if (m) base.claudePidByPid[Number(m[1])] = Number(m[2])
      }
      for (const line of args.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
        if (!m) continue
        base.argsByPid[Number(m[1])] = m[3]!
        const age = ageOf(m[2]!)
        if (age !== null) base.ageByPid[Number(m[1])] = age
      }
      let pid = 0
      for (const line of cwds.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        if (line.startsWith('n') && pid) base.cwdByPid[pid] = line.slice(1)
      }
    }

    const next = buildSnapshot(base)
    await $.fs.write(file, JSON.stringify(next))
    await update($, snapshot, () => next.snapshot)
  } finally {
    isTicking = false
  }
}

async function readDocker($: Engine): Promise<DockerInput | null> {
  const ps = await run($, ['docker', 'ps', '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.project.working_dir"}}'])
  const ids = ps.split('\n').map(line => line.split('|')[0]!).filter(Boolean)
  if (ids.length === 0) return null
  // Only these variables leave Docker: a container's other env may hold secrets.
  const env = '{{range .Config.Env}}{{$k := index (split . "=") 0}}{{if or (eq $k "CI_SHA") (eq $k "CI_BRANCH")}}{{.}};{{end}}{{end}}'
  const [stats, inspect, ...tops] = await Promise.all([
    run($, ['docker', 'stats', '--no-stream', '--format', '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}']),
    run($, ['docker', 'inspect', '--format', `{{.Id}}|{{.State.StartedAt}}|${env}`, ...ids]),
    ...ids.map(id => run($, ['docker', 'top', id, '-o', 'pid,pcpu,etime,args'])),
  ])

  return { ps, stats, inspect, topById: Object.fromEntries(ids.map((id, i) => [id, tops[i] ?? ''])) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'load', description: 'Show this Mac’s load and what is using it' })
    void $.ui.open({ id: PANE, title: 'Machine load' })
    void tick($)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'load' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Machine load' })
    await update($, isDetailsOpen, () => true)
    await update($, view, openSorted)

    return { text: 'Machine load pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap) return next(e)

    return chip($, $.ui.resolve(e), snap)
  })

  // The band stacks each mod's row; this re-lays it so the chip sits on the same line as the other rows.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const others = e.props.rows.filter(row => row.plugin !== PLUGIN)
    const snap = await read($, snapshot)
    if (!snap || others.length === e.props.rows.length || others.length === 0) return next(e)
    const elements = $.ui.resolve(e)
    const rest = await next({ ...e, props: { ...e.props, rows: others } })
    const { Box } = elements
    const { Svg } = elements as typeof elements & { Svg?: any }
    // Ponytail's expanded view is taller, which leaves room for a plot under the chip; any read failure means collapsed.
    const ponytail = (await (read as any)($, { plugin: 'ponytail', key: 'band' }).catch(() => undefined)) as
      | { details?: boolean }
      | undefined
    const hasPlot = ponytail?.details === true && Svg && snap.history.length > 1

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexDirection="column" alignItems="flex-start" flexShrink={0} gap={1}>
          {chip($, elements, snap)}
          {hasPlot && (
            <Svg source={chart(snap, 120, 32, false)} alt={`Load over the last half hour, now ${formatLoad(snap.load1)}`} width={120} height={32} />
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {rest}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = elements as typeof elements & { Svg?: any }
    const snap = await read($, snapshot)
    if (!snap) return <Text dimColor>Measuring this Mac…</Text>

    const mood = verdict(snap.load1, snap.cores)
    const number = formatLoad(snap.load1)

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column" alignItems="center" padding={1}>
          <Text size="title" weight="semibold" tabular color={mood.tone}>
            {number}
          </Text>
          <Text size="caption" dimColor>
            load · {mood.word}
          </Text>
        </Box>
      )
    }

    const isOpen = await read($, isDetailsOpen)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="flex-end" gap={1}>
          <Text size="title" weight="semibold" tabular color={mood.tone}>
            {number}
          </Text>
          <Text weight="medium" color={mood.tone}>
            {mood.word}
          </Text>
          <Text dimColor tabular>
            5 min {formatLoad(snap.load5)} · 15 min {formatLoad(snap.load15)}
          </Text>
        </Box>
        <Text>{explain(snap.load1, snap.cores)}</Text>
        <Text dimColor tabular>
          CPU {pct(snap.cpuPct)} · GPU {pct(snap.gpuPct)} · Memory free {pct(snap.memFreePct)} · {snap.cores} cores ·{' '}
          {snap.runnable} programs running right now
        </Text>
        {Svg && snap.history.length > 1 && (
          <Svg
            source={chart(snap)}
            alt={`Load over the last ${Math.round((snap.at - snap.history[0]!.at) / 60000)} minutes, now ${number}, against ${snap.cores} cores`}
            width={340}
            height={96}
          />
        )}
        <Button
          key="details"
          label={isOpen ? 'Hide details' : 'What is using it?'}
          variant="secondary"
          onPress={async () => {
            const willOpen = !isOpen
            await update($, isDetailsOpen, () => willOpen)
            if (willOpen) await update($, view, openSorted)
          }}
        />
        {isOpen && snap.cpuPct === null && <Text dimColor>Measuring per-program use; ready in about 10 seconds.</Text>}
        {isOpen && snap.cpuPct !== null && details($, elements, snap, await read($, view))}
        {isOpen && (
          <Text size="caption" dimColor>
            CPU % is a share of one core (100% = one core fully busy; {snap.cores * 100}% = the whole Mac). Docker rows
            show the CI containers and databases inside Docker&apos;s VM, so their CPU is also part of the Docker row. Fan speed needs
            admin rights on Apple Silicon, so it is not shown.
          </Text>
        )}
      </Box>
    )
  })
}

function chart(snap: Snapshot, w = 340, h = 96, hasLabel = true): string {
  const pad = 4
  const first = snap.history[0]!.at
  const span = Math.max(1, snap.at - first)
  const top = Math.max(snap.cores * 1.2, ...snap.history.map(p => p.load)) * 1.05
  const x = (at: number) => pad + ((at - first) / span) * (w - pad * 2)
  const y = (load: number) => h - pad - (load / top) * (h - pad * 2)
  const points = snap.history.map(p => `${x(p.at).toFixed(1)},${y(p.load).toFixed(1)}`).join(' ')
  const coreY = y(snap.cores).toFixed(1)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<style>
.line{fill:none;stroke:#3b6fd4;stroke-width:1.5}
.cap{stroke:#8a8f98;stroke-dasharray:3 3;stroke-width:1}
.lab{fill:#6b7079;font:11px -apple-system,system-ui,sans-serif}
@media (prefers-color-scheme: dark){.line{stroke:#7aa2f7}.cap{stroke:#5c6270}.lab{fill:#9aa0aa}}
</style>
<line class="cap" x1="${pad}" x2="${w - pad}" y1="${coreY}" y2="${coreY}"/>
${hasLabel ? `<text class="lab" x="${w - pad}" y="${Number(coreY) - 4}" text-anchor="end">${snap.cores} cores = full</text>` : ''}
<polyline class="line" points="${points}"/>
</svg>`
}

function chip($: Engine, { Box, Text, Button }: ReturnType<Engine['ui']['resolve']>, snap: Snapshot) {
  return (
    <Box key="machine-load-chip" flexDirection="row" alignItems="center" flexShrink={0}>
      <Text color={verdict(snap.load1, snap.cores).tone}>●</Text>
      <Button
        key="machine-load-open"
        label={`Load ${formatLoad(snap.load1)}`}
        plain
        onPress={() => $.ui.open({ id: PANE, title: 'Machine load' })}
      />
    </Box>
  )
}
