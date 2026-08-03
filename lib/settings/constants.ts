// Deliberately has NO `import 'server-only'` — this is just a string
// constant, safe to import from anywhere (including test files that import
// settings.impl.ts directly under plain Vitest/Node, outside Next's
// "react-server" bundler condition, where 'server-only' throws
// unconditionally on import). The actual sensitive logic (the Supabase RPC
// call, the unstable_cache wrapper) stays guarded in default-language-cache.ts.

export const DEFAULT_LANGUAGE_CACHE_TAG = 'app-settings-default-language'
