import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import './globals.css'

// Self-hosted (not next/font/google): the Vercel build-time fetch to Google
// Fonts failed intermittently ("Error while requesting resource" ->
// Turbopack "Module not found: .../internal/font/google/font"), breaking
// deploys on a dependency the build has no control over. Both files below
// are the same latin-subset woff2s Google's CDN was serving (Cormorant
// Garamond / Plus Jakarta Sans are variable fonts -- Google returns the same
// file for every requested static weight; each weight entry below points at
// that one file, same as the browser was already doing via the CDN).
const cormorant = localFont({
  src: [
    { path: './fonts/cormorant-garamond.woff2', weight: '400', style: 'normal' },
    { path: './fonts/cormorant-garamond.woff2', weight: '500', style: 'normal' },
    { path: './fonts/cormorant-garamond.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-cormorant',
  display: 'swap',
})

const jakarta = localFont({
  src: [
    { path: './fonts/plus-jakarta-sans.woff2', weight: '300', style: 'normal' },
    { path: './fonts/plus-jakarta-sans.woff2', weight: '400', style: 'normal' },
    { path: './fonts/plus-jakarta-sans.woff2', weight: '500', style: 'normal' },
    { path: './fonts/plus-jakarta-sans.woff2', weight: '600', style: 'normal' },
    { path: './fonts/plus-jakarta-sans.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-jakarta',
  display: 'swap',
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata')
  return {
    title: t('title'),
    description: t('description'),
    icons: { icon: '/brand/logo-primary.png' },
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html
      lang={locale}
      className={`${cormorant.variable} ${jakarta.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-cream text-charcoal">
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
