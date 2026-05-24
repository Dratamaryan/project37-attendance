import { PublicShell } from '@/components/PublicShell'
import { LoginForm } from './LoginForm'

export default function LoginPage() {
  return (
    <PublicShell>
      <main className="flex-1 flex items-center justify-center p-6">
        <LoginForm />
      </main>
    </PublicShell>
  )
}
