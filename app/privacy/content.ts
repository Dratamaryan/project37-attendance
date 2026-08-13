import { promises as fs } from 'fs'
import path from 'path'

export const SUPPORTED_LOCALES = ['id', 'en'] as const
export type PrivacyLocale = (typeof SUPPORTED_LOCALES)[number]

export function resolvePrivacyLocale(locale: string): PrivacyLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) ? (locale as PrivacyLocale) : 'id'
}

export async function loadPrivacyPolicyContent(locale: string): Promise<string> {
  const safeLocale = resolvePrivacyLocale(locale)
  const filePath = path.join(process.cwd(), 'content', 'legal', `privacy-policy.${safeLocale}.md`)
  return fs.readFile(filePath, 'utf-8')
}
