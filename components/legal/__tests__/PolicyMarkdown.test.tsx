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

  describe('links (S9-R5)', () => {
    it('https:// link -> <a> opening in a new tab with noopener noreferrer', () => {
      render(<PolicyMarkdown content={'See [Cloudflare\'s addendum](https://www.cloudflare.com/turnstile-privacy-policy/) for details.'} />)
      const a = screen.getByRole('link', { name: "Cloudflare's addendum" })
      expect(a).toHaveAttribute('href', 'https://www.cloudflare.com/turnstile-privacy-policy/')
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', 'noopener noreferrer')
      expect(a.closest('p')).toHaveTextContent("See Cloudflare's addendum for details.")
    })

    it('works inside list items and bold spans', () => {
      const { container } = render(<PolicyMarkdown content={'- **[A](https://a.example/)** and [B](https://b.example/x?y=1)'} />)
      expect(container.querySelector('li strong a')).toHaveAttribute('href', 'https://a.example/')
      expect(screen.getByRole('link', { name: 'B' })).toHaveAttribute('href', 'https://b.example/x?y=1')
    })

    it.each([
      ['javascript:', '[click](javascript:alert(1))'],
      ['javascript: (no parens)', '[click](javascript:void0)'],
      ['http:', '[plain](http://example.com/)'],
      ['mailto:', '[mail](mailto:a@example.com)'],
      ['relative', '[rel](/privacy)'],
      ['protocol-relative', '[pr](//evil.example/)'],
      ['scheme case trick', '[x](HTTPS://example.com/)'],
      ['data:', '[d](data:text/html;base64,PHNjcmlwdD4=)'],
    ])('%s -> literal text, no <a>', (_label, src) => {
      const { container } = render(<PolicyMarkdown content={src} />)
      expect(container.querySelector('a')).toBeNull()
      expect(container.querySelector('p')!.textContent).toBe(src)
    })

    it.each([
      ['nested brackets in text', '[a [b] c](https://example.com/)'],
      ['double brackets', '[[x]](https://example.com/)'],
      ['space in url', '[x](https://example.com/a b)'],
    ])('%s -> no <a>, source kept as text', (_label, src) => {
      const { container } = render(<PolicyMarkdown content={src} />)
      expect(container.querySelector('a')).toBeNull()
      expect(container.querySelector('p')!.textContent).toBe(src)
    })
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
