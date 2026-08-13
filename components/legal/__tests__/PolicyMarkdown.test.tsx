// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PolicyMarkdown } from '../PolicyMarkdown'
import { privacyPolicyId as idContent } from '@/content/legal/privacy-policy.id'
import { privacyPolicyEn as enContent } from '@/content/legal/privacy-policy.en'

describe('PolicyMarkdown', () => {
  it('renders the id (Indonesian) section headings', () => {
    render(<PolicyMarkdown content={idContent} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Kebijakan Privasi' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '1. Siapa Kami' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '13. Hubungi Kami' })).toBeInTheDocument()
  })

  it('renders the en (English) section headings', () => {
    render(<PolicyMarkdown content={enContent} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '1. Who We Are' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '13. Contact Us' })).toBeInTheDocument()
  })

  it('renders bold inline spans as <strong>, not raw asterisks', () => {
    render(<PolicyMarkdown content={enContent} />)
    expect(screen.getAllByText('project37events@gmail.com', { selector: 'strong' }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
  })

  it('renders list items as <li> elements', () => {
    render(<PolicyMarkdown content={enContent} />)
    const items = screen.getAllByRole('listitem')
    expect(items.length).toBeGreaterThan(0)
  })

  it('never injects raw HTML — the leading HTML comment is stripped, not rendered', () => {
    const { container } = render(<PolicyMarkdown content={idContent} />)
    expect(container.innerHTML).not.toContain('<!--')
    expect(screen.queryByText(/CANONICAL/)).not.toBeInTheDocument()
  })

  it('does not execute or render markup embedded in content as HTML', () => {
    const { container } = render(
      <PolicyMarkdown content={'# Title\n\n<script>window.__xss = true</script> plain text'} />
    )
    // Rendered as literal text, never parsed as an element — no <script> node exists in the DOM.
    expect(screen.getByText(/<script>window\.__xss = true<\/script>/)).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})
