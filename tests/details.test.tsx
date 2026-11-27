import { expect, test } from 'claude-code/testing'

const row = (key: string, label: string, cpu: number, extra = {}) => ({ key, pid: 1, label, folder: null, cpu, memMb: 10, ageSec: 60, containers: [], ...extra })
const SNAP = {
  at: 1, load1: 18.4, load5: 10, load15: 8, cores: 10, cpuPct: 50, gpuPct: 10, memFreePct: 60, runnable: 20, history: [],
  sections: [
    { key: 'sessions', title: 'Claude sessions', cpu: 90, groups: [
      { key: 's1', title: 'Billing API', cpu: 60, procs: [row('p1', 'Jest test worker', 60)], containers: [] },
      { key: 's2', title: 'Mobile release', cpu: 30, procs: [row('p2', 'Next.js dev server', 30)], containers: [] },
    ] },
    { key: 'system', title: 'Mac apps and system', cpu: 300, groups: [
      { key: 'system', title: 'Mac apps and system', cpu: 300, containers: [], procs: [row('p3', 'Docker Linux VM (all containers)', 300, {
        containers: [{ key: 'c1', label: 'CI gate (acme-backend)', branch: 'feature/billing', step: 'jobs: unit', cpu: 150, memMb: 2048, ageSec: 3600, owner: 'Billing API', folder: 'acme-backend-billing' }],
      })] },
    ] },
  ],
}
const PANE = {
  plugin: 'machine-load', component: 'Pane', requestId: 'machine-load',
  props: { title: 'Machine load', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function seed(on: any) {
  on('state.get', { plugin: 'machine-load', key: 'snapshot' }, () => ({ value: { value: { shape: 'snapshot-2', value: SNAP }, version: 1 } }))
}

test('the table sorts by CPU, collapses sections and finds work by search', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  const texts = async () => (await ui.findAll({ type: 'Button' } as any)).map((b: any) => b.props.label)
  await ui.press({ key: 'details' } as any)

  expect((await texts()).includes('CPU ↓')).toBe(true)
  const labels = await texts()
  expect(labels.indexOf('▾ Billing API') < labels.indexOf('▾ Mobile release')).toBe(true)
  expect(labels.includes('▸ Mac apps and system (1)')).toBe(true)

  await ui.press({ key: 't-s1' } as any)
  expect((await texts()).includes('▸ Billing API')).toBe(true)

  await ui.input({ key: 'search', text: 'mobile release', kind: 'change' } as any)
  const found = await texts()
  expect(found.includes('▾ Mobile release')).toBe(true)
  expect(found.some((l: string) => l.includes('Billing API'))).toBe(false)

  await ui.input({ key: 'search', text: 'feature/billing', kind: 'change' } as any)
  const gate = await ui.find({ type: 'Text', text: /from Billing API/ } as any)
  expect(gate !== undefined).toBe(true)
  await ui.unmount()
})

test('expand all opens every section and Docker; collapse all closes them', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  const labels = async () => (await ui.findAll({ type: 'Button' } as any)).map((b: any) => b.props.label)
  await ui.press({ key: 'details' } as any)

  expect((await labels()).includes('Expand all')).toBe(true)
  await ui.press({ key: 'toggle-all' } as any)
  const open = await labels()
  expect(open.includes('▾ Mac apps and system (1)')).toBe(true)
  expect(open.includes('▾ Docker Linux VM (all containers)')).toBe(true)
  expect(open.includes('Collapse all')).toBe(true)

  await ui.press({ key: 'toggle-all' } as any)
  const shut = await labels()
  expect(shut.includes('▸ Claude sessions (2)')).toBe(true)
  expect(shut.includes('▸ Mac apps and system (1)')).toBe(true)
  expect(shut.some((l: string) => l.includes('Billing API'))).toBe(false)
  await ui.unmount()
})

test('typing in search is never overwritten by a redraw', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'details' } as any)
  await ui.input({ key: 'search', text: 'mob', kind: 'change' } as any)
  const field = (await ui.find({ type: 'Input', key: 'search' } as any)) as any
  expect(field?.props?.value).toBe(undefined)
  await ui.unmount()
})

test('/load demo shows only made-up sessions and toggles back', async ($, on) => {
  seed(on)
  on('command.register', () => ({ value: { command: 'load' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const first = await $.command.run({ command: 'load', args: 'demo' } as any)
  expect(String((first as any)?.text).startsWith('Demo data on')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'details' } as any)
  const labels = (await ui.findAll({ type: 'Button' } as any)).map((b: any) => b.props.label)
  expect(labels.includes('▾ Billing API: invoice export')).toBe(true)
  expect(labels.includes('▾ Billing API')).toBe(false)
  await ui.unmount()
  const second = await $.command.run({ command: 'load', args: 'demo' } as any)
  expect(String((second as any)?.text).startsWith('Demo data off')).toBe(true)
})
