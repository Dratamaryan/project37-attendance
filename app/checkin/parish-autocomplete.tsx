'use client'

import { useState, useRef, useEffect, useCallback, useId } from 'react'
import { useTranslations } from 'next-intl'
import { searchParishes, createPendingParish } from '@/lib/actions/parishes'
import type { ParishSearchResult } from '@/lib/actions/parishes.types'

type Props = {
  value: string | null
  onChange: (value: string | null) => void
  onCreatingChange: (creating: boolean) => void
}

export function ParishAutocomplete({ value, onChange, onCreatingChange }: Props) {
  const t = useTranslations('checkin.form')
  const [inputValue, setInputValue] = useState(value ?? '')
  const [isOpen, setIsOpen] = useState(false)
  const [results, setResults] = useState<ParishSearchResult[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const search = useCallback(async (query: string) => {
    const result = await searchParishes(query, { includePending: true })
    if (result.status === 'success') {
      setResults(result.parishes.slice(0, 20))
    }
  }, [])

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setInputValue(val)
    // Clear the selected value when the user modifies the input
    if (val !== value) onChange(null)
    setIsOpen(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(val), 250)
  }

  function handleFocus() {
    setIsOpen(true)
    search(inputValue)
  }

  function handleSelect(parish: ParishSearchResult) {
    setInputValue(parish.name)
    onChange(parish.name)
    setIsOpen(false)
  }

  async function handleAddNew() {
    const name = inputValue.trim()
    if (!name) return
    setIsCreating(true)
    onCreatingChange(true)
    try {
      const result = await createPendingParish({ name })
      if (result.status === 'created') {
        setInputValue(result.parish.name)
        onChange(result.parish.name)
      } else if (result.status === 'duplicate') {
        setInputValue(result.existing.name)
        onChange(result.existing.name)
      }
      // validation_error / error: keep dropdown open with current input
    } finally {
      setIsCreating(false)
      onCreatingChange(false)
      setIsOpen(false)
    }
  }

  const hasExactMatch = results.some(
    (p) => p.name.toLowerCase() === inputValue.trim().toLowerCase(),
  )
  const showAddNew = inputValue.trim().length > 0 && !hasExactMatch && !isCreating

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        placeholder={t('parish_search_placeholder')}
        autoComplete="off"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={t('origin_parish_label')}
        className="w-full px-3 py-2 text-sm bg-white border border-line rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted"
      />
      {isOpen && (results.length > 0 || showAddNew || isCreating) && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full bg-white border border-line rounded-sm shadow-md max-h-60 overflow-auto"
        >
          {results.map((parish) => (
            <li
              key={parish.id}
              role="option"
              aria-selected={parish.name === value}
              onMouseDown={(e) => e.preventDefault()} // prevent blur before click
              onClick={() => handleSelect(parish)}
              className="px-3 py-2 text-sm cursor-pointer hover:bg-cream-2 flex items-center justify-between"
            >
              <span>
                <span className="text-charcoal">{parish.name}</span>
                {(parish.city || parish.region) && (
                  <span className="text-xs text-muted ml-2">
                    {[parish.city, parish.region].filter(Boolean).join(', ')}
                  </span>
                )}
              </span>
              {parish.status === 'pending' && (
                <span className="ml-2 flex-shrink-0 text-xs px-1.5 py-0.5 bg-cream-2 border border-line rounded text-muted">
                  {t('parish_pending_badge')}
                </span>
              )}
            </li>
          ))}
          {isCreating && (
            <li className="px-3 py-2 text-sm text-muted italic" aria-live="polite">
              Creating parish...
            </li>
          )}
          {showAddNew && (
            <li
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleAddNew}
              className="px-3 py-2 text-sm cursor-pointer hover:bg-cream-2 border-t border-line font-medium text-[#A8924A]"
            >
              {t('parish_add_new', { name: inputValue.trim() })}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
