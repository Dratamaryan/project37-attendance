import { privacyPolicyId } from '@/content/legal/privacy-policy.id'
import { privacyPolicyEn } from '@/content/legal/privacy-policy.en'

export const SUPPORTED_LOCALES = ['id', 'en'] as const
export type PrivacyLocale = (typeof SUPPORTED_LOCALES)[number]

const POLICY_CONTENT: Record<PrivacyLocale, string> = {
  id: privacyPolicyId,
  en: privacyPolicyEn,
}

export function resolvePrivacyLocale(locale: string): PrivacyLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) ? (locale as PrivacyLocale) : 'id'
}

export function loadPrivacyPolicyContent(locale: string): string {
  return POLICY_CONTENT[resolvePrivacyLocale(locale)]
}
