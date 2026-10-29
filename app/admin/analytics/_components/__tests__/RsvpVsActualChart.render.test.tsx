// @vitest-environment jsdom
//
// S9-R6 B — the REAL RsvpVsActualChart rendered through Recharts (nothing in
// recharts or the component is mocked). jsdom has no layout engine, so the
// only shims are the size inputs ResponsiveContainer reads: a ResizeObserver
// that reports a fixed 600×280 box, and the matching element dimensions.
// Closes the R7 gap where the legend/tooltip contrast bug shipped because the
// chart was only ever tested with a stub.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import RsvpVsActualChart from '../RsvpVsActualChart'
import type { RsvpChartRow } from '@/lib/actions/rsvp-analytics.types'

const WIDTH = 600
const HEIGHT = 280

/** Every --color-* token in app/globals.css, by name, as lower-case hex. */
function designTokens(): Map<string, string> {
  const css = readFileSync(path.resolve(process.cwd(), 'app/globals.css'), 'utf8')
  const tokens = new Map<string, string>()
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens.set(m[1]!, m[2]!.toLowerCase())
  return tokens
}

function row(date: string, coming: number, adults: number, children: number): RsvpChartRow {
  return {
    event_instance_id: `inst-${date}`,
    event_id: 'event-1',
    event_type: 'adhoc',
    scheduled_at: `${date}T11:00:00Z`,
    ended_at: `${date}T13:00:00Z`,
    coming_people: coming,
    coming_headcount: coming,
   
    coming_came: 0,
    coming_no_show: 0,
    walk_ins: 0,
    actual_adults: adults,
    actual_children: children,
    newcomer_rsvps: 0,
    became_members: 0,
    invited: 0,
    invited_responded: 0,
    invited_attended: 0,
    scheduled_date: date,
  }
}

const DATA = [row('2026-10-01', 6, 5, 3), row('2026-10-08', 4, 3, 1)]

const originalRO = globalThis.ResizeObserver
const dims = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const
const originalDims = dims.map((d) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, d))

beforeAll(() => {
  class FixedSizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      const contentRect = { width: WIDTH, height: HEIGHT, top: 0, left: 0, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: () => ({}) }
      this.cb([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = FixedSizeObserver as unknown as typeof ResizeObserver
  for (const d of dims) {
    Object.defineProperty(HTMLElement.prototype, d, { configurable: true, get: () => (d.endsWith('Width') ? WIDTH : HEIGHT) })
  }
})

afterAll(() => {
  globalThis.ResizeObserver = originalRO
  dims.forEach((d, i) => {
    const desc = originalDims[i]
    if (desc) Object.defineProperty(HTMLElement.prototype, d, desc)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[d]
  })
})

function renderChart() {
  return render(
    <RsvpVsActualChart
      data={DATA}
      labelComing="Coming headcount"
      labelAdults="Actual adults"
      labelChildren="Actual children"
      emptyMessage="empty"
      errorMessage="error"
      hasError={false}
    />,
  )
}

describe('RsvpVsActualChart — real Recharts render (fixed 600×280)', () => {
  it('lays out: SVG at the fixed size, 3 series, 2 bars + 2 line paths with real geometry', async () => {
    const { container } = renderChart()

    const svg = container.querySelector('svg.recharts-surface')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('width')).toBe(String(WIDTH))
    expect(svg!.getAttribute('height')).toBe(String(HEIGHT))

    // Series: one Bar + two Lines.
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(1)
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(2)

    // Bars appear once the entry animation has run.
    await waitFor(() => expect(container.querySelectorAll('.recharts-bar .recharts-rectangle')).toHaveLength(DATA.length), { timeout: 5000 })
    for (const bar of container.querySelectorAll('.recharts-bar .recharts-rectangle')) {
      expect(Number(bar.getAttribute('width'))).toBeGreaterThan(0)
      expect(Number(bar.getAttribute('height'))).toBeGreaterThan(0)
    }

    const curves = container.querySelectorAll('.recharts-line-curve')
    expect(curves).toHaveLength(2)
    for (const c of curves) expect(c.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+/)
  })

  it('legend item texts, in series order', () => {
    const { container } = renderChart()
    const items = [...container.querySelectorAll('[data-testid^="rsvp-legend-"]')].map((e) => e.textContent)
    expect(items).toEqual(['Coming headcount', 'Actual adults', 'Actual children'])
  })

  it('series colours are design tokens from globals.css — never transparent/none, bar fill distinct from the card', async () => {
    const tokens = designTokens()
    const tokenValues = new Set(tokens.values())
    const { container } = renderChart()
    await waitFor(() => expect(container.querySelectorAll('.recharts-bar .recharts-rectangle').length).toBeGreaterThan(0), { timeout: 5000 })

    const bar = container.querySelector('.recharts-bar .recharts-rectangle')!
    const [adults, children] = [...container.querySelectorAll('.recharts-line-curve')]
    const colours = {
      barFill: bar.getAttribute('fill'),
      barStroke: bar.getAttribute('stroke'),
      adultsStroke: adults!.getAttribute('stroke'),
      childrenStroke: children!.getAttribute('stroke'),
    }

    for (const [series, colour] of Object.entries(colours)) {
      expect(colour, series).toBeTruthy()
      expect(['none', 'transparent'], series).not.toContain(colour!.toLowerCase())
      expect(tokenValues.has(colour!.toLowerCase()), `${series} ${colour} is not a --color-* token`).toBe(true)
    }
    expect(colours.barFill!.toLowerCase()).toBe(tokens.get('gold-light'))
    expect(colours.barStroke!.toLowerCase()).toBe(tokens.get('gold'))
    expect(colours.adultsStroke!.toLowerCase()).toBe(tokens.get('gold'))
    expect(colours.childrenStroke!.toLowerCase()).toBe(tokens.get('ink-2'))
    // The bar sits on a cream-2 card: its fill must not be the card colour.
    expect(colours.barFill!.toLowerCase()).not.toBe(tokens.get('cream-2'))
  })
})
