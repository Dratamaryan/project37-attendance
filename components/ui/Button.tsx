import { type ComponentProps } from 'react'

type Variant = 'primary' | 'ghost'

type Props = ComponentProps<'button'> & {
  variant?: Variant
}

export function Button({ variant = 'primary', className = '', ...props }: Props) {
  const base = 'rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50'
  const variants: Record<Variant, string> = {
    primary: 'bg-gold text-charcoal hover:bg-gold-dark',
    ghost: 'border border-line text-ink-2 hover:border-gold hover:text-gold',
  }
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props} />
  )
}
