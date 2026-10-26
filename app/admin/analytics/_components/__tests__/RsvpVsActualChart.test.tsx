// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  RsvpChartLegend,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
} from '../RsvpVsActualChart'

const CHARCOAL_RGB = 'rgb(61, 56, 51)' // #3D3833

describe('RsvpVsActualChart legend / tooltip contrast', () => {
  it('all three legend labels render in charcoal, whatever the series colour', () => {
    render(<RsvpChartLegend labels={{ coming: 'Coming', adults: 'Adults', children: 'Children' }} />)
    for (const [key, text] of [['coming', 'Coming'], ['adults', 'Adults'], ['children', 'Children']] as const) {
      const label = screen.getByTestId(`rsvp-legend-${key}`).querySelector('span:last-child') as HTMLElement
      expect(label).toHaveTextContent(text)
      expect(label.style.color).toBe(CHARCOAL_RGB)
    }
  })

  it('coming-headcount swatch is the light fill with a gold border (visible on the card)', () => {
    render(<RsvpChartLegend labels={{ coming: 'Coming', adults: 'Adults', children: 'Children' }} />)
    const swatch = screen.getByTestId('rsvp-legend-coming').querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(swatch.style.background).toBe('rgb(245, 239, 217)')   // #F5EFD9
    expect(swatch.style.borderColor).toBe('rgb(168, 146, 74)')     // #A8924A
    expect(swatch.style.borderStyle).toBe('solid')
  })

  it('line icons use the series colours: adults gold, children charcoal', () => {
    render(<RsvpChartLegend labels={{ coming: 'Coming', adults: 'Adults', children: 'Children' }} />)
    expect(screen.getByTestId('rsvp-legend-adults').querySelector('line')?.getAttribute('stroke')).toBe('#A8924A')
    expect(screen.getByTestId('rsvp-legend-children').querySelector('line')?.getAttribute('stroke')).toBe('#3D3833')
  })

  it('tooltip item and label text are charcoal for every series', () => {
    expect(TOOLTIP_ITEM_STYLE).toEqual({ color: '#3D3833' })
    expect(TOOLTIP_LABEL_STYLE).toEqual({ color: '#3D3833' })
  })
})
