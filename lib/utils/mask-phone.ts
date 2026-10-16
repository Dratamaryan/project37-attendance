const MASK = '••••'

/** "+6281234561234" → "•••• 1234". Non-E.164 (e.g. anonymized 'anon:<uuid>') → "••••". */
export function maskPhoneLast4(phoneE164: string): string {
  if (!/^\+\d{5,15}$/.test(phoneE164)) return MASK
  return `${MASK} ${phoneE164.slice(-4)}`
}
