const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[setupTests.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). Integration tests must run against local Docker only ` +
      `— check .env.test.local exists and 'supabase start' is running.`
  )
}

import '@testing-library/jest-dom'
