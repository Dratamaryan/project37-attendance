'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ImportPreviewTable } from './_components/ImportPreviewTable'
import { ImportResultSummary } from './_components/ImportResultSummary'
import type { ClassificationCounts, ClassifiedRow } from '@/lib/import/types'

interface DryRunResponse {
  importId: string
  filename: string
  totalRows: number
  classificationCounts: ClassificationCounts
  rows: ClassifiedRow[]
}

interface CommitResponse {
  importId: string
  filename: string
  classificationCounts: ClassificationCounts
  attempted: number
  inserted: number
  raced: number
  skippedDup: number
  skippedError: number
}

const KNOWN_ERROR_KEYS = new Set([
  'parse_failed',
  'sheet_not_found',
  'missing_required_columns',
  'file_too_large',
  'unsupported_extension',
])

type Phase =
  | { step: 'idle'; error?: string }
  | { step: 'previewing' }
  | { step: 'preview_ready'; data: DryRunResponse; error?: string }
  | { step: 'committing'; data: DryRunResponse }
  | { step: 'committed'; data: CommitResponse }

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function ImportClient() {
  const t = useTranslations('admin.import')
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })

  function errorMessage(err: unknown): string {
    const code = err instanceof Error ? err.message : 'upload_failed'
    return KNOWN_ERROR_KEYS.has(code) ? t(`error.${code}`) : t('error.upload_failed')
  }

  async function postFile(mode: 'dry_run' | 'commit') {
    const formData = new FormData()
    formData.append('mode', mode)
    formData.append('file', file as File)
    const res = await fetch('/api/admin/import/people', { method: 'POST', body: formData })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'upload_failed')
    return json
  }

  async function handlePreview() {
    if (!file) {
      setPhase({ step: 'idle', error: t('error.no_file') })
      return
    }
    setPhase({ step: 'previewing' })
    try {
      const data = (await postFile('dry_run')) as DryRunResponse
      setPhase({ step: 'preview_ready', data })
    } catch (err) {
      setPhase({ step: 'idle', error: errorMessage(err) })
    }
  }

  async function handleCommit() {
    if (phase.step !== 'preview_ready') return
    const { data } = phase
    setPhase({ step: 'committing', data })
    try {
      const result = (await postFile('commit')) as CommitResponse
      setPhase({ step: 'committed', data: result })
    } catch (err) {
      setPhase({ step: 'preview_ready', data, error: errorMessage(err) })
    }
  }

  function handleStartOver() {
    setFile(null)
    setPhase({ step: 'idle' })
  }

  function handleDownloadErrors() {
    if (phase.step !== 'preview_ready' && phase.step !== 'committing') return
    const errorRows = phase.data.rows.filter((r) => r.rowClass === 'error')
    const lines = [
      ['row #', 'phone', 'name', 'reason'].join(','),
      ...errorRows.map((row) =>
        [
          String(row.sourceRowNumber),
          row.phone_e164 ?? '',
          row.full_name ?? '',
          row.reason ?? '',
        ]
          .map(escapeCsvCell)
          .join(','),
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `import-errors-${phase.data.filename}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const busy = phase.step === 'previewing' || phase.step === 'committing'

  return (
    <div className="space-y-6" data-import-phase={phase.step}>
      <div>
        <label htmlFor="import-file" className="block text-sm font-medium text-charcoal mb-1">
          {t('file_label')}
        </label>
        <input
          id="import-file"
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setPhase({ step: 'idle' })
          }}
          className="block w-full text-sm text-ink-2 file:mr-4 file:py-2 file:px-4 file:rounded-sm file:border-0 file:bg-gold file:text-white file:text-sm file:font-medium file:cursor-pointer"
        />
        <p className="text-xs text-muted mt-1">{t('file_hint')}</p>
      </div>

      {phase.step === 'idle' && phase.error && (
        <p id="import-error-message" className="text-sm text-red-600">{phase.error}</p>
      )}

      {(phase.step === 'idle' || phase.step === 'previewing') && (
        <button
          id="import-preview-button"
          type="button"
          onClick={handlePreview}
          disabled={!file || busy}
          className="inline-flex items-center rounded-sm bg-gold px-4 py-2 text-sm font-medium text-white hover:bg-gold-dark transition-colors disabled:opacity-50"
        >
          {phase.step === 'previewing' ? t('upload_button_pending') : t('upload_button')}
        </button>
      )}

      {(phase.step === 'preview_ready' || phase.step === 'committing') && (
        <div className="space-y-4">
          <ImportPreviewTable
            filename={phase.data.filename}
            totalRows={phase.data.totalRows}
            classificationCounts={phase.data.classificationCounts}
            rows={phase.data.rows}
          />

          {phase.step === 'preview_ready' && phase.error && (
            <p id="import-error-message" className="text-sm text-red-600">{phase.error}</p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              id="import-download-errors-button"
              type="button"
              onClick={handleDownloadErrors}
              disabled={phase.data.classificationCounts.error === 0}
              className="inline-flex items-center rounded-sm border border-line px-4 py-2 text-sm font-medium text-ink-2 hover:text-charcoal transition-colors disabled:opacity-50"
            >
              {t('download_errors_button')}
            </button>
            <button
              id="import-commit-button"
              type="button"
              onClick={handleCommit}
              disabled={busy}
              className="inline-flex items-center rounded-sm bg-gold px-4 py-2 text-sm font-medium text-white hover:bg-gold-dark transition-colors disabled:opacity-50"
            >
              {phase.step === 'committing' ? t('commit_button_pending') : t('commit_button')}
            </button>
          </div>
        </div>
      )}

      {phase.step === 'committed' && (
        <div className="space-y-4">
          <ImportResultSummary
            filename={phase.data.filename}
            attempted={phase.data.attempted}
            inserted={phase.data.inserted}
            raced={phase.data.raced}
            skippedDup={phase.data.skippedDup}
            skippedError={phase.data.skippedError}
          />
          <button
            id="import-start-over-button"
            type="button"
            onClick={handleStartOver}
            className="inline-flex items-center rounded-sm border border-line px-4 py-2 text-sm font-medium text-ink-2 hover:text-charcoal transition-colors"
          >
            {t('start_over_button')}
          </button>
        </div>
      )}
    </div>
  )
}
