import type { View } from '../types'

export const DEFAULT_VIEW: View = {
  sort: { column: 'cpu', isDescending: true },
  collapsed: ['system'],
  expanded: [],
  query: '',
  resorts: 0,
}

export const openSorted = (v: View): View => ({ ...v, sort: { column: 'cpu', isDescending: true }, resorts: v.resorts + 1 })
