// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecentPanel } from '../recent-panel'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />
  },
}))

describe('RecentPanel — S8-T5 "view all attendees" link', () => {
  it('links to the selected instance\'s attendee list', () => {
    render(<RecentPanel attendances={[]} eventName="Ibadah" eventInstanceId="inst-123" />)
    const link = screen.getByTestId('view-all-attendees')
    expect(link).toHaveAttribute('href', '/checkin/inst-123/attendees')
    expect(link).toHaveTextContent('recent_panel.view_all')
  })

  it('link takes its own full-width row on narrow screens, inline from md up', () => {
    // jsdom has no layout engine — assert the responsive contract via classes.
    render(<RecentPanel attendances={[]} eventName="Ibadah" eventInstanceId="inst-123" />)
    const link = screen.getByTestId('view-all-attendees')
    expect(link).toHaveClass('basis-full', 'md:basis-auto')
    expect(link.parentElement).toHaveClass('flex-wrap', 'md:flex-nowrap')
    // heading is a direct sibling, so it owns the first row and truncates there
    expect(screen.getByTestId('recent-panel-heading').parentElement).toBe(link.parentElement)
  })

  it('renders no link when no instance is selected', () => {
    render(<RecentPanel attendances={[]} eventName={null} eventInstanceId={null} />)
    expect(screen.queryByTestId('view-all-attendees')).not.toBeInTheDocument()
  })
})
