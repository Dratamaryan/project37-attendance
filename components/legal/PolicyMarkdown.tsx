import { type ReactNode } from 'react'

type Props = {
  content: string
}

// Minimal, dependency-free renderer for the fixed Markdown subset used by the
// self-authored legal docs in content/legal/: '#'/'##' headings, '- ' lists,
// '**bold**'/'*italic*' inline spans, and plain paragraphs. Renders only React
// text/element nodes (never dangerouslySetInnerHTML), so there is no HTML
// injection surface regardless of what the source file contains.
function renderInline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={i}>{part.slice(1, -1)}</em>
      }
      return part
    })
}

export function PolicyMarkdown({ content }: Props) {
  const blocks = content
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(block => block.length > 0 && !block.startsWith('<!--'))

  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        const lines = block.split('\n').map(line => line.trim())

        if (lines[0].startsWith('## ')) {
          return (
            <h2 key={i} className="font-heading text-xl font-semibold text-charcoal mt-8 first:mt-0">
              {renderInline(lines[0].slice(3))}
            </h2>
          )
        }

        if (lines[0].startsWith('# ')) {
          return (
            <h1 key={i} className="font-heading text-3xl font-semibold text-charcoal">
              {renderInline(lines[0].slice(2))}
            </h1>
          )
        }

        if (lines.every(line => line.startsWith('- '))) {
          return (
            <ul key={i} className="list-disc pl-5 space-y-1 text-sm text-ink-2 leading-relaxed">
              {lines.map((line, j) => (
                <li key={j}>{renderInline(line.slice(2))}</li>
              ))}
            </ul>
          )
        }

        return (
          <p key={i} className="text-sm text-ink-2 leading-relaxed">
            {renderInline(lines.join(' '))}
          </p>
        )
      })}
    </div>
  )
}
