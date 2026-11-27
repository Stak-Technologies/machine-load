import { expect, test } from 'claude-code/testing'

const SNAP = {
  at: 1, load1: 18.4, load5: 10, load15: 8, cores: 10, cpuPct: 50, gpuPct: 10, memFreePct: 60,
  runnable: 20, sections: [], history: [{ at: 0, load: 5 }, { at: 1, load: 18.4 }],
}
const BAND = { isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const OTHER_ROW = { plugin: 'ponytail', tree: { type: 'Text', props: {}, children: ['ponytail band'] } }

test('the chip shares one line with another mod row', async ($, on) => {
  on('state.get', () => ({ value: { value: { shape: 'snapshot-2', value: SNAP }, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core">{(e.props as any).rows?.map((r: any) => r.tree)}</Box>
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({
      plugin: 'machine-load',
      surface,
      component: 'AbovePromptList',
      props: { ...BAND, hasSurvey: false, rows: [{ plugin: 'machine-load', tree: { type: 'Text', props: {}, children: ['x'] } }, OTHER_ROW] },
    } as any)
    const outer = await ui.find({ type: 'Box' } as any)
    expect((outer as any)?.props?.flexDirection).toBe('row')
    expect((await ui.find({ type: 'Button', key: 'machine-load-open' } as any)) !== undefined).toBe(true)
    await ui.unmount()
  }
})

for (const details of [true, false]) {
  test(`the plot shows only while ponytail is expanded (${details})`, async ($, on) => {
    on('state.get', { plugin: 'ponytail' } as any, () => ({ value: { value: { details }, version: 1 } }))
    on('state.get', { plugin: 'machine-load' } as any, () => ({ value: { value: { shape: 'snapshot-2', value: SNAP }, version: 1 } }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box key="core">{(e.props as any).rows?.map((r: any) => r.tree)}</Box>
    })
    const ui = await $.ui.mount({
      plugin: 'machine-load',
      surface: 'desktop',
      component: 'AbovePromptList',
      props: { ...BAND, hasSurvey: false, rows: [{ plugin: 'machine-load', tree: { type: 'Text', props: {}, children: ['x'] } }, OTHER_ROW] },
    } as any)
    expect((await ui.find({ type: 'Svg' } as any)) !== undefined).toBe(details)
    await ui.unmount()
  })
}
