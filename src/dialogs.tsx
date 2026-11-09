import { useMemo, useState } from 'react'
import { EXTENSION, type DownloadFormat } from './export/download'
import { diffLines, hunks, type DiffLine } from './state/diff'
import { EDIT, SAVED, type Doc, type Version } from './state/documents'
import { fitsBed, printerOf } from './state/printers'
import { Dialog, fileName, whenEdited } from './ui'

/** Who made a version, and how: the label is the prompt for a turn, a marker for anything else. */
function origin(v: Version): string {
  if (v.label === EDIT) return 'You · edit'
  if (v.label === SAVED) return 'You · saved'
  if (v.label === 'new') return 'Started'
  return v.compileOk ? 'Assistant' : "Assistant · didn't compile"
}

/** A version's one-line name, as History and the top bar show it. */
export const versionTitle = (v: Version): string =>
  v.label === EDIT ? 'Edited by hand' : v.label === SAVED ? 'Saved version' : v.label === 'new' ? 'First version' : v.label

const changes = (doc: Doc, v: Version): DiffLine[] =>
  hunks(diffLines(doc.versions.find((p) => p.id === v.parentId)?.source ?? '', v.source))

function DiffLines({ lines, limit }: { lines: readonly DiffLine[]; limit?: number }) {
  const shown = limit === undefined ? lines : lines.slice(0, limit)
  return (
    <pre className="diff">
      {lines.length === 0
        ? 'No difference.'
        : shown.map((line, i) => (
            <span key={i} className={line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}>
              {line.kind} {line.text}
              {'\n'}
            </span>
          ))}
      {shown.length < lines.length && <span className="more">… {lines.length - shown.length} more lines</span>}
    </pre>
  )
}

/**
 * Every version, newest first. A row opens to what it changed against the
 * version it was made from, with Restore. Restore moves the head; the list
 * itself never shrinks.
 */
export function HistoryPanel({
  open,
  doc,
  focus,
  busy,
  onClose,
  onSave,
  onRestore,
  onFullDiff,
}: {
  open: boolean
  doc: Doc | null
  /** The row to open with, e.g. from a chat result card's Changes. */
  focus: string | null
  busy: boolean
  onClose: () => void
  onSave: () => void
  onRestore: (id: string) => void
  onFullDiff: (id: string) => void
}) {
  return (
    <Dialog open={open && doc !== null} onClose={onClose} label="History" className="sheet history">
      {doc && <HistoryBody doc={doc} focus={focus} busy={busy} onClose={onClose} onSave={onSave} onRestore={onRestore} onFullDiff={onFullDiff} />}
    </Dialog>
  )
}

function HistoryBody({
  doc,
  focus,
  busy,
  onClose,
  onSave,
  onRestore,
  onFullDiff,
}: {
  doc: Doc
  focus: string | null
  busy: boolean
  onClose: () => void
  onSave: () => void
  onRestore: (id: string) => void
  onFullDiff: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(focus)
  const rows = [...doc.versions].reverse()
  return (
    <>
      <div className="dialog-head">
        <h2>History</h2>
        <button type="button" className="btn" disabled={busy} onClick={onSave} title="Keep what is in the editor as a version of its own">
          Save version
        </button>
        <button type="button" className="dialog-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <ol className="history-list">
        {rows.map((v) => {
          const current = v.id === doc.head
          const isOpen = expanded === v.id
          return (
            <li key={v.id} className={isOpen ? 'open' : ''}>
              <button type="button" className="history-row" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : v.id)}>
                <span className="history-id">v{v.id}</span>
                <span className="history-text">
                  <span className="history-label">
                    {versionTitle(v)}
                    {current && <span className="badge ok">Current</span>}
                  </span>
                  <span className={origin(v).endsWith("didn't compile") ? 'history-meta bad' : 'history-meta'}>
                    {origin(v)} · {whenEdited(v.ts)}
                  </span>
                </span>
              </button>
              {isOpen && (
                <div className="history-detail">
                  <DiffLines lines={changes(doc, v)} limit={12} />
                  <div className="row">
                    <button type="button" className="btn primary" disabled={busy || (current && doc.source === v.source)} onClick={() => onRestore(v.id)}>
                      Restore
                    </button>
                    <button type="button" className="btn" disabled={!v.parentId} onClick={() => onFullDiff(v.id)}>
                      Full diff
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <p className="dialog-foot">Nothing is deleted. Restoring makes an old version current; the ones after it stay here.</p>
    </>
  )
}

/** One version against the one it was made from, whole. */
export function VersionDiff({ doc, versionId, onClose }: { doc: Doc | null; versionId: string | null; onClose: () => void }) {
  const version = doc && versionId ? doc.versions.find((v) => v.id === versionId) ?? null : null
  const lines = useMemo(() => (doc && version ? changes(doc, version) : []), [doc, version])
  return (
    <Dialog open={version !== null} onClose={onClose} label="Changes" className="diff-dialog">
      {doc && version && (
        <>
          <div className="dialog-head">
            <h2>
              v{version.id} · {versionTitle(version)}
              <span className="dialog-sub"> against v{version.parentId ?? '?'}</span>
            </h2>
            <button type="button" className="dialog-x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <DiffLines lines={lines} />
        </>
      )}
    </Dialog>
  )
}

const FORMATS: readonly { format: DownloadFormat; name: string; what: string }[] = [
  { format: '3mf', name: '3MF', what: 'Keeps parts separate and their colours. Opens in PrusaSlicer, Bambu Studio, Orca and Cura.' },
  { format: 'binstl', name: 'STL', what: 'One mesh. Works everywhere, loses part boundaries and colour.' },
  { format: 'obj', name: 'OBJ', what: 'With a colour file beside it, for rendering tools.' },
]

/** One Export: a format with its reason, whole model or the selected part, and the bed check. */
export function ExportDialog({
  open,
  doc,
  parts,
  size,
  part,
  bed,
  exporting,
  error,
  onClose,
  onExport,
}: {
  open: boolean
  doc: Doc | null
  parts: number
  /** The whole model's size, mm. */
  size: readonly number[] | null
  /** The clicked part, if any: it can go out alone. */
  part: { n: number; size: readonly number[] } | null
  bed: readonly [number, number, number]
  exporting: boolean
  error: string | null
  onClose: () => void
  onExport: (format: DownloadFormat, part: number | null) => Promise<boolean>
}) {
  const [format, setFormat] = useState<DownloadFormat>('3mf')
  const [alone, setAlone] = useState(false)
  const only = alone && part ? part : null
  const measured = only ? only.size : size
  const printer = printerOf(bed)
  const name = `${fileName(doc ? doc.name : 'model')}${only ? ` part ${only.n}` : ''}.${EXTENSION[format]}`
  return (
    <Dialog open={open} onClose={onClose} label="Export for printing" className="export">
      <div className="dialog-head">
        <h2>Export for printing</h2>
        <button type="button" className="dialog-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="seg wide" role="group" aria-label="What to export">
        <button type="button" aria-pressed={!only} onClick={() => setAlone(false)}>
          Whole model{parts > 1 ? ` · ${parts} parts` : ''}
        </button>
        <button
          type="button"
          aria-pressed={only !== null}
          disabled={!part}
          title={part ? undefined : 'Click a part in the view to export it alone'}
          onClick={() => setAlone(true)}
        >
          {part ? `Part ${part.n} only` : 'One part only'}
        </button>
      </div>
      <div className="formats" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => (
          <label key={f.format} className={format === f.format ? 'format on' : 'format'}>
            <input type="radio" name="format" checked={format === f.format} onChange={() => setFormat(f.format)} />
            <span>
              <b>
                {f.name}
                {f.format === '3mf' && <span className="format-tag">Recommended</span>}
              </b>
              <span>{f.what}</span>
            </span>
          </label>
        ))}
      </div>
      {measured && (
        <p className={fitsBed(measured, bed) ? 'fit ok' : 'fit bad'}>
          {fitsBed(measured, bed)
            ? `✓ Fits your ${printer ?? 'printer'} (${bed.join(' × ')} mm)`
            : `! Larger than your ${printer ?? 'printer'} (${bed.join(' × ')} mm). Change the printer in Settings if that is wrong.`}
        </p>
      )}
      {error && <pre className="export-error">{error}</pre>}
      <button
        type="button"
        className="btn primary big"
        disabled={exporting || !size}
        onClick={() => void onExport(format, only?.n ?? null).then((ok) => ok && onClose())}
      >
        {exporting ? 'Exporting…' : `Download ${name}`}
      </button>
    </Dialog>
  )
}
