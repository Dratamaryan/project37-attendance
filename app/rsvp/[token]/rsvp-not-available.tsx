// The ONE "not available" view for every dead link — unknown, inactive,
// expired, cancelled or past-window token, and a submit that comes back
// 'closed'. No hooks and no 'use client': rendered by the server page and by
// the client form alike, with strings resolved by the caller.

type Props = {
  title: string
  body: string
  /**
   * 1 when this view IS the page (server closed view); 2 when it replaces the
   * form under the event's own <h1> (in-form 'closed' swap).
   */
  headingLevel?: 1 | 2
}

export function RsvpNotAvailable({ title, body, headingLevel = 1 }: Props) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <div className="rounded-2xl bg-cream-2 border border-line p-6 text-center" data-testid="rsvp-not-available">
      <Heading className="font-heading text-2xl font-semibold text-charcoal mb-2">{title}</Heading>
      <p className="text-sm text-ink-2 leading-relaxed">{body}</p>
    </div>
  )
}
