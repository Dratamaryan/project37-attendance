import { type ReactNode } from 'react'

type Props = {
  children: ReactNode
  className?: string
}

export function Card({ children, className = '' }: Props) {
  return (
    <div className={`rounded-2xl bg-cream-2 border border-line p-6 ${className}`}>
      {children}
    </div>
  )
}
