import { AppTopbar } from '@/components/AppTopbar'
import { type ReactNode } from 'react'

type Props = { children: ReactNode }

export default async function DashboardLayout({ children }: Props) {
  return (
    <>
      <AppTopbar />
      <div className="pb-16 md:pb-0">{children}</div>
    </>
  )
}
