import type { View } from '../types'

export const DEFAULT_VIEW: View = {
  sort: { column: 'cpu', isDescending: true },
  collapsed: ['system'],
  expanded: [],
  query: '',
  resorts: 0,
}

// The search field keeps its own text (handing it back on each redraw jumped the cursor), so opening the details clears the filter to match the empty field.
export const openSorted = (v: View): View => ({ ...v, query: '', sort: { column: 'cpu', isDescending: true }, resorts: v.resorts + 1 })
