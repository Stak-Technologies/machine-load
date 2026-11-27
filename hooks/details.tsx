import { atom, update } from 'claude-code'
import type { EngineInterface as Engine } from 'claude-code'

import type { ContainerRow, Group, ProcRow, Snapshot, SortColumn, View } from '../types'
import { arrange, formatAge, matches } from './sample'
import { DEFAULT_VIEW } from './state'

const viewAtom = atom({ plugin: 'machine-load', key: 'view' } as const, DEFAULT_VIEW)

type Elements = ReturnType<Engine['ui']['resolve']>
type Metric = { name: string; age: number; cpu: number; mem: number }
type Line = {
  key: string
  depth: number
  name: string
  sub?: string
  age: number | null
  cpu: number
  mem: number
  isBold?: boolean
  toggle?: { isOpen: boolean; onPress: () => unknown }
}

const COLUMNS: { column: SortColumn; label: string; width: string }[] = [
  { column: 'name', label: 'Name', width: '54%' },
  { column: 'age', label: 'Running', width: '15%' },
  { column: 'cpu', label: 'CPU', width: '13%' },
  { column: 'mem', label: 'Memory', width: '18%' },
]

// Row order survives redraws so the table holds still between samples; it is re-sorted only on a header press.
const orders = new Map<string, string[]>()
let seenResorts = -1

const procMetric = (p: ProcRow): Metric => ({ name: p.label, age: p.ageSec ?? -1, cpu: p.cpu, mem: p.memMb })
const containerMetric = (c: ContainerRow): Metric => ({ name: `${c.label} ${c.branch ?? ''}`, age: c.ageSec ?? -1, cpu: c.cpu, mem: c.memMb })
const groupMetric = (g: Group): Metric => ({
  name: g.title,
  age: Math.max(-1, ...g.procs.map(p => p.ageSec ?? -1), ...g.containers.map(c => c.ageSec ?? -1)),
  cpu: g.cpu,
  mem: [...g.procs, ...g.containers].reduce((sum, r) => sum + r.memMb, 0),
})
const formatMem = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`)

export function details($: Engine, elements: Elements, snap: Snapshot, view: View) {
  const { Box, Text, Button, Input } = elements as Elements & { Input: any }
  const isResort = view.resorts !== seenResorts
  seenResorts = view.resorts
  const query = view.query.trim()
  const isSearching = query !== ''
  const sign = view.sort.isDescending ? -1 : 1
  const by =
    <T,>(metric: (item: T) => Metric) =>
    (a: T, b: T) => {
      const x = metric(a)
      const y = metric(b)
      const column = view.sort.column
      return column === 'name' ? sign * x.name.localeCompare(y.name) : sign * (x[column] - y[column])
    }
  const ordered = <T,>(parent: string, items: T[], keyOf: (item: T) => string, metric: (item: T) => Metric) => {
    const result = arrange(orders.get(parent), items, keyOf, by(metric), isResort)
    orders.set(parent, result.map(keyOf))
    return result
  }

  const setView = (change: (v: View) => View) => update($, viewAtom, change)
  const toggleIn = (list: 'collapsed' | 'expanded', key: string) =>
    setView(v => ({ ...v, [list]: v[list].includes(key) ? v[list].filter(k => k !== key) : [...v[list], key] }))
  const isOpen = (key: string) => isSearching || !view.collapsed.includes(key)
  const isExpanded = (key: string) => isSearching || view.expanded.includes(key)
  const containerHit = (c: ContainerRow) => matches(query, c.label, c.branch, c.step, c.owner, c.folder)

  const lines: Line[] = []
  const containerLine = (c: ContainerRow, depth: number, showOwner: boolean): Line => ({
    key: c.key + depth,
    depth,
    name: c.label,
    sub: [c.branch, c.step, showOwner ? `from ${c.owner ?? 'no session found'}` : 'in Docker'].filter(Boolean).join(' · '),
    age: c.ageSec,
    cpu: c.cpu,
    mem: c.memMb,
  })

  const addGroup = (group: Group, depth: number) => {
    const groupHit = matches(query, group.title)
    const procs = group.procs.filter(p => !isSearching || groupHit || matches(query, p.label, p.folder) || p.containers.some(containerHit))
    const containers = group.containers.filter(c => !isSearching || groupHit || containerHit(c))
    for (const proc of ordered(`${group.key}/p`, procs, p => p.key, procMetric)) {
      const hasContainers = proc.containers.length > 0
      lines.push({
        key: proc.key,
        depth,
        name: proc.label,
        sub: proc.folder ?? undefined,
        age: proc.ageSec,
        cpu: proc.cpu,
        mem: proc.memMb,
        toggle: hasContainers ? { isOpen: isExpanded(proc.key), onPress: () => toggleIn('expanded', proc.key) } : undefined,
      })
      if (hasContainers && isExpanded(proc.key)) {
        const shown = proc.containers.filter(c => !isSearching || matches(query, proc.label) || containerHit(c))
        for (const c of ordered(`${proc.key}/c`, shown, x => x.key, containerMetric)) lines.push(containerLine(c, depth + 1, true))
      }
    }
    for (const c of ordered(`${group.key}/c`, containers, x => x.key, containerMetric)) lines.push(containerLine(c, depth, false))
  }

  for (const section of snap.sections) {
    const groups = section.groups.filter(
      g =>
        !isSearching ||
        matches(query, g.title) ||
        g.procs.some(p => matches(query, p.label, p.folder) || p.containers.some(containerHit)) ||
        g.containers.some(containerHit),
    )
    if (groups.length === 0) continue
    const sectionOpen = isOpen(section.key)
    lines.push({
      key: section.key,
      depth: 0,
      name: `${section.title} (${groups.length})`,
      age: null,
      cpu: groups.reduce((sum, g) => sum + g.cpu, 0),
      mem: groups.reduce((sum, g) => sum + groupMetric(g).mem, 0),
      isBold: true,
      toggle: { isOpen: sectionOpen, onPress: () => toggleIn('collapsed', section.key) },
    })
    if (!sectionOpen) continue
    const isFlat = section.key === 'system'
    for (const group of ordered(section.key, groups, g => g.key, groupMetric)) {
      if (isFlat) {
        addGroup(group, 1)
        continue
      }
      const metric = groupMetric(group)
      lines.push({
        key: group.key,
        depth: 1,
        name: section.key === 'detached' ? `Jobs in ${group.title}` : group.title,
        age: metric.age < 0 ? null : metric.age,
        cpu: group.cpu,
        mem: metric.mem,
        toggle: { isOpen: isOpen(group.key), onPress: () => toggleIn('collapsed', group.key) },
      })
      if (isOpen(group.key)) addGroup(group, 2)
    }
  }

  const collapsible = snap.sections.flatMap(s => [s.key, ...s.groups.map(g => g.key)])
  const expandable = snap.sections.flatMap(s => s.groups.flatMap(g => g.procs.filter(p => p.containers.length > 0).map(p => p.key)))
  const isAllOpen = view.collapsed.length === 0 && expandable.every(key => view.expanded.includes(key))

  const pressHeader = (column: SortColumn) =>
    setView(v => ({
      ...v,
      sort: { column, isDescending: v.sort.column === column ? !v.sort.isDescending : column !== 'name' },
      resorts: v.resorts + 1,
    }))

  return (
    <Box key="details" flexDirection="column" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Input
            key="search"
            placeholder="Search a session, folder, branch or program (e.g. billing api)"
            value={view.query}
            onInput={(value: string) => setView(v => ({ ...v, query: value }))}
            onSubmit={(value: string) => setView(v => ({ ...v, query: value }))}
          />
        </Box>
        {/* The desktop draws the label; other surfaces draw the glyph pair. The hover card is the tooltip. */}
        <Box key="toggle-all-wrap" position="relative" flexShrink={0}>
          <Button
            key="toggle-all"
            variant="secondary"
            label={isAllOpen ? 'Collapse all' : 'Expand all'}
            onPress={() =>
              setView(v => (isAllOpen ? { ...v, collapsed: [...collapsible], expanded: [] } : { ...v, collapsed: [], expanded: [...expandable] }))
            }
          >
            {isAllOpen ? '⇈' : '⇊'}
          </Button>
          <Box
            position="absolute"
            top={2}
            right={0}
            display="none"
            hover={{ display: 'flex' }}
            borderStyle="round"
            backgroundColor="inverseText"
            paddingX={1}
          >
            <Text size="caption">{isAllOpen ? 'Collapse all sections' : 'Expand all sections'}</Text>
          </Box>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box flexDirection="row">
          {COLUMNS.map(c => (
            <Box key={`h-${c.column}`} width={c.width} justifyContent={c.column === 'name' ? 'flex-start' : 'flex-end'}>
              <Button
                key={`sort-${c.column}`}
                plain
                label={view.sort.column === c.column ? `${c.label} ${view.sort.isDescending ? '↓' : '↑'}` : c.label}
                onPress={() => pressHeader(c.column)}
              />
            </Box>
          ))}
        </Box>
        {lines.length === 0 && <Text dimColor>Nothing running matches “{query}”.</Text>}
        {lines.map(line => (
          <Box key={`r-${line.key}`} flexDirection="row" alignItems="flex-start">
            <Box width={COLUMNS[0]!.width} flexDirection="column" paddingLeft={line.depth * 2}>
              {line.toggle ? (
                <Button
                  key={`t-${line.key}`}
                  plain
                  label={`${line.toggle.isOpen ? '▾' : '▸'} ${line.name}`}
                  onPress={line.toggle.onPress}
                />
              ) : (
                <Text weight={line.isBold ? 'semibold' : 'regular'}>{line.name}</Text>
              )}
              {line.sub && (
                <Text size="caption" dimColor>
                  {line.sub}
                </Text>
              )}
            </Box>
            <Box width={COLUMNS[1]!.width} justifyContent="flex-end">
              <Text tabular dimColor>
                {formatAge(line.age)}
              </Text>
            </Box>
            <Box width={COLUMNS[2]!.width} justifyContent="flex-end">
              <Text tabular weight={line.isBold ? 'semibold' : 'regular'}>
                {Math.round(line.cpu)}%
              </Text>
            </Box>
            <Box width={COLUMNS[3]!.width} justifyContent="flex-end">
              <Text tabular dimColor>
                {formatMem(line.mem)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
