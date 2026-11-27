import { expect, test } from 'claude-code/testing'

import { arrange, buildSnapshot, describe, explain, liveSessions, matches, owningSession, parseCpuTime } from '../hooks/sample'

test('cpu time parses minutes, hours and days', async () => {
  expect(parseCpuTime('1:30.50')).toBe(90.5)
  expect(parseCpuTime('2:00:00')).toBe(7200)
  expect(parseCpuTime('1-00:00:10')).toBe(86410)
})

test('labels never repeat raw arguments', async () => {
  const label = describe('/opt/homebrew/bin/node', 'node /x/serve.js --token=sk-SECRET123')
  expect(label).toBe('Node: serve.js')
  expect(label.includes('SECRET')).toBe(false)
  expect(describe('node', 'node /repo/node_modules/jest-worker/build/workers/processChild.js')).toBe('Jest test worker')
  expect(describe('python3.11', 'python -m pytest tests/unit')).toBe('Python tests (pytest)')
})

test('a session is only trusted when its process start time matches', async () => {
  const sessions = [
    { pid: 10, name: 'a', cwd: '/r', procStart: 'Thu Nov  6 17:16:16 2026' },
    { pid: 11, name: 'b', cwd: '/r', procStart: 'Thu Nov 26 17:16:16 2026' },
  ]
  const live = liveSessions(sessions, { 10: 'Thu Nov 6 17:16:16 2026', 11: 'Fri Nov 27 01:00:00 2026' })
  expect(live.map(s => s.pid)).toEqual([10])
})

test('the parent walk stops on a loop', async () => {
  const parentOf = new Map([
    [5, 6],
    [6, 5],
  ])
  expect(owningSession(5, parentOf, new Set([99]))).toBe(null)
  expect(owningSession(5, new Map([[5, 7], [7, 99]]), new Set([99]))).toBe(99)
})

test('cpu comes from the time delta and work is credited to its session', async () => {
  const ps = [
    '99 1 0:10.00 1000 S /Users/me/.local/bin/claude',
    '200 99 0:05.00 2048 R /opt/homebrew/bin/node',
    '300 1 0:20.00 4096 R /opt/homebrew/bin/node',
  ].join('\n')
  const { snapshot } = buildSnapshot({
    at: 20_000,
    ps,
    loadavg: '{ 25.00 12.00 6.00 }\n10',
    gpu: '"Device Utilization %"=18',
    memory: 'System-wide memory free percentage: 60%',
    prevCpuSec: { 99: 10, 200: 0, 300: 10 },
    prevAt: 10_000,
    sessions: [{ pid: 99, name: 'My session', cwd: '/repo', procStart: 'x' }],
    argsByPid: { 200: 'node /repo/node_modules/.bin/jest', 300: 'node /tmp/other/run.js' },
    cwdByPid: { 300: '/tmp/other' },
    ageByPid: { 200: 65 },
    claudePidByPid: {},
    docker: null,
    history: [],
  })

  expect(snapshot.load1).toBe(25)
  expect(snapshot.cores).toBe(10)
  expect(snapshot.gpuPct).toBe(18)
  expect(snapshot.memFreePct).toBe(60)
  expect(snapshot.runnable).toBe(2)
  expect(snapshot.sections.map(s => [s.key, s.groups.map(g => [g.title, Math.round(g.cpu)])])).toEqual([
    ['sessions', [['My session', 50]]],
    ['detached', [['other', 100]]],
  ])
  const jest = snapshot.sections[0]?.groups[0]?.procs[0]
  expect(jest?.label).toBe('Jest test runner')
  expect(jest?.ageSec).toBe(65)
  expect(explain(25, 10).includes('2.5×')).toBe(true)
})

test('a Docker gate is credited to the session that ran it', async () => {
  const ps = [
    '99 1 0:10.00 1000 S /Users/me/.local/bin/claude',
    '150 99 0:00.10 1000 S /bin/bash',
    '160 150 0:00.10 1000 S docker',
    '400 1 1:00.00 900000 R /System/Library/Frameworks/Virtualization.framework/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
  ].join('\n')
  const { snapshot } = buildSnapshot({
    at: Date.parse('2026-11-27T16:00:00Z'),
    ps,
    loadavg: '{ 5 5 5 }\n10',
    gpu: '',
    memory: '',
    prevCpuSec: { 400: 0 },
    prevAt: Date.parse('2026-11-27T15:59:50Z'),
    sessions: [{ pid: 99, name: 'Billing API', cwd: '/repo', procStart: 'x' }],
    argsByPid: { 160: 'docker run --rm -i -e CI_SHA=abc123 -e CI_BRANCH=feature/billing acme-backend-ci:1 bash -c ...' },
    cwdByPid: { 160: '/wt/acme-backend-billing' },
    ageByPid: {},
    claudePidByPid: {},
    docker: {
      ps: 'c1|eager|acme-backend-ci:1|',
      stats: 'c1|150.5%|2.5GiB / 23GiB',
      inspect: 'c1full|2026-11-27T15:00:00Z|CI_SHA=abc123;CI_BRANCH=feature/billing;',
      topById: { c1: 'PID %CPU ELAPSED COMMAND\n1 0.0 1:00 /sbin/docker-init\n2 99.0 59:00 python3 -m pytest tests/unit' },
    },
    history: [],
  })

  const session = snapshot.sections.find(s => s.key === 'sessions')?.groups[0]
  expect(session?.title).toBe('Billing API')
  expect(session?.containers.map(c => [c.label, c.branch, c.step, c.ageSec, c.memMb])).toEqual([
    ['CI gate (acme-backend)', 'feature/billing', 'Python tests (pytest)', 3600, 2560],
  ])
  const vm = snapshot.sections.find(s => s.key === 'system')?.groups[0]?.procs[0]
  expect(vm?.label).toBe('Docker Linux VM (all containers)')
  expect(vm?.containers[0]?.owner).toBe('Billing API')
  expect(vm?.containers[0]?.folder).toBe('acme-backend-billing')
})

test('search ignores case, spaces and dashes', async () => {
  expect(matches('mobile release', 'Jobs in', 'acme-mobile-release')).toBe(true)
  expect(matches('Billing api', 'Plan: Billing api auto-eval')).toBe(true)
  expect(matches('zebra', 'acme-web')).toBe(false)
  expect(matches('', 'anything')).toBe(true)
})

test('rows hold their place between samples until a resort', async () => {
  const cpu = (x: { k: string; cpu: number }) => x.k
  const desc = (a: { cpu: number }, b: { cpu: number }) => b.cpu - a.cpu
  const first = arrange(undefined, [{ k: 'a', cpu: 1 }, { k: 'b', cpu: 9 }], cpu, desc, false)
  expect(first.map(cpu)).toEqual(['b', 'a'])
  const later = arrange(['b', 'a'], [{ k: 'a', cpu: 50 }, { k: 'b', cpu: 2 }, { k: 'c', cpu: 99 }], cpu, desc, false)
  expect(later.map(cpu)).toEqual(['b', 'a', 'c'])
  const resorted = arrange(['b', 'a'], [{ k: 'a', cpu: 50 }, { k: 'b', cpu: 2 }, { k: 'c', cpu: 99 }], cpu, desc, true)
  expect(resorted.map(cpu)).toEqual(['c', 'a', 'b'])
})

test('a job let go of by its shell is still credited through CLAUDE_PID', async () => {
  const { snapshot } = buildSnapshot({
    at: 20_000,
    ps: ['99 1 0:10.00 1000 S claude', '500 1 0:20.00 1000 R /opt/homebrew/bin/node'].join('\n'),
    loadavg: '{ 1 1 1 }\n10',
    gpu: '',
    memory: '',
    prevCpuSec: { 500: 10 },
    prevAt: 10_000,
    sessions: [{ pid: 99, name: 'Invoice export', cwd: '/repo', procStart: 'x' }],
    argsByPid: { 500: 'node /wt/node_modules/.bin/jest' },
    cwdByPid: { 500: '/wt/acme-web-invoices' },
    ageByPid: {},
    claudePidByPid: { 500: 99 },
    docker: null,
    history: [],
  })
  expect(snapshot.sections.map(s => [s.key, s.groups[0]?.title])).toEqual([['sessions', 'Invoice export']])
})

test('without CI_SHA a container links to the one docker run using its image', async () => {
  const { snapshot } = buildSnapshot({
    at: Date.parse('2026-11-27T16:00:00Z'),
    ps: ['99 1 0:10.00 1000 S claude', '160 99 0:00.10 1000 S docker'].join('\n'),
    loadavg: '{ 1 1 1 }\n10',
    gpu: '',
    memory: '',
    prevCpuSec: {},
    prevAt: null,
    sessions: [{ pid: 99, name: 'Search service', cwd: '/repo', procStart: 'x' }],
    argsByPid: { 160: 'docker run --rm redis:7' },
    cwdByPid: {},
    ageByPid: {},
    claudePidByPid: {},
    docker: { ps: 'r1|cache|redis:7|', stats: 'r1|1.0%|10MiB / 1GiB', inspect: 'r1full|2026-11-27T15:00:00Z|', topById: {} },
    history: [],
  })
  const session = snapshot.sections.find(s => s.key === 'sessions')?.groups[0]
  expect(session?.containers.map(c => [c.label, c.owner])).toEqual([['Redis cache', 'Search service']])
})
