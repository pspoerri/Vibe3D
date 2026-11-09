import { useEffect, useState } from 'react'
import { EXAMPLES } from './examples'
import { toDataUrl } from './llm/images'
import { downloadBlob } from './export/download'
import { deleteDoc, newDoc, renameDoc, suggestName, UNTITLED, type Session } from './state/documents'
import { exportProject } from './state/project'
import type { Units } from './state/units'
import { fileName, Menu, whenEdited } from './ui'

/** Injected by vite.config.ts: `git describe`, and the short commit hash — empty on the clean release tag. */
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
export const REPO_URL = 'https://github.com/pspoerri/Vibe3D'
/** As in the chat: a plain cap, the providers enforce their own. */
const MAX_IMAGES = 4

export type EditTab = 'params' | 'code'
/** How a document created here opens. */
export type Opening = { prompt: { text: string; images: readonly string[] } } | { edit: EditTab }

/**
 * A document's thumbnail: an object URL for the Blob's lifetime on screen.
 * Made and revoked in the same effect — a URL from useMemo outlives StrictMode's
 * first cleanup, which revokes it, and the image shows broken.
 */
function Thumb({ blob }: { blob: Blob | undefined }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return setUrl(null)
    const made = URL.createObjectURL(blob)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [blob])
  return <span className="start-thumb">{url && <img src={url} alt="" />}</span>
}

/** "A mounting plate" → "Mounting plate": the examples are named as sentences, shown as titles. */
const title = (name: string): string => name.replace(/^An? (.)/, (_, c: string) => c.toUpperCase())

/**
 * The launcher. The prompt is the first thing on the page: typing creates the
 * document. Below it the documents, most recently edited first, because the
 * top row is almost always the thing you were in the middle of.
 */
export function StartWindow({
  session,
  durable,
  units,
  onUnits,
  onOpen,
  onChange,
  onCreate,
}: {
  session: Session
  durable: boolean
  units: Units
  onUnits: (next: Units) => void
  onOpen: (id: string) => void
  onChange: (next: Session) => void
  /** A new document, opened: with a prompt for the chat to send at once, or with the editor on a tab. */
  onCreate: (id: string, how: Opening) => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<readonly string[]>([])
  const rows = [...session.docs].sort((a, b) => b.updatedAt - a.updatedAt)
  const create = (name: string, source: string, how: Opening) => {
    const id = crypto.randomUUID()
    onChange({ docs: [...session.docs, newDoc(name, source, id, Date.now())], currentId: id })
    onCreate(id, how)
  }
  const submit = () => {
    if (!text.trim() && images.length === 0) return
    create(UNTITLED, '', { prompt: { text: text.trim(), images } })
  }

  return (
    <div className="start">
      <div className="start-card">
        <section className="start-hero">
          <h1>What do you want to print?</h1>
          <form
            className="start-prompt"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {images.length > 0 && (
              <div className="chat-tray">
                {images.map((url, i) => (
                  <button
                    key={i}
                    type="button"
                    className="chat-thumb"
                    aria-label="Remove image"
                    onClick={() => setImages((current) => current.filter((_, j) => j !== i))}
                  >
                    <img src={url} alt="" />
                  </button>
                ))}
              </div>
            )}
            <textarea
              aria-label="Describe the part"
              rows={2}
              value={text}
              placeholder="A wall hook for a 30 mm broom handle, two screw holes, prints without supports…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <div className="start-prompt-row">
              <label className="chip-btn">
                + Reference image
                <input
                  type="file"
                  aria-label="Attach a reference image"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  onChange={(e) => {
                    const picked = [...(e.target.files ?? [])].slice(0, MAX_IMAGES - images.length)
                    e.target.value = ''
                    void Promise.allSettled(picked.map(toDataUrl)).then((settled) =>
                      setImages((current) => [
                        ...current,
                        ...settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])),
                      ]),
                    )
                  }}
                />
              </label>
              <button
                type="button"
                className="chip-btn"
                title="How you give sizes. The model itself is always millimetres."
                onClick={() => onUnits(units === 'mm' ? 'in' : 'mm')}
              >
                Units: {units === 'mm' ? 'mm' : 'inches'}
              </button>
              <button type="submit" className="btn primary" disabled={!text.trim() && images.length === 0}>
                Create model
              </button>
            </div>
          </form>
          <p className="start-or">
            Or{' '}
            <button type="button" className="link" onClick={() => create(UNTITLED, '', { edit: 'code' })}>
              start with an empty document
            </button>{' '}
            and write OpenSCAD yourself.
          </p>
        </section>

        <div className="start-grid">
          <section>
            <div className="start-section-head">
              <h2>Recent</h2>
              <span>
                {rows.length} {rows.length === 1 ? 'document' : 'documents'}, saved in this browser
              </span>
            </div>
            <ul className="start-list">
              {rows.map((d) => (
                <li key={d.id}>
                  <button type="button" className="start-open" onClick={() => onOpen(d.id)}>
                    <Thumb blob={d.thumb} />
                    <span className="start-text">
                      <span className="start-name">{d.name}</span>
                      <span className="start-meta">
                        {d.versions.length} {d.versions.length === 1 ? 'version' : 'versions'}
                      </span>
                    </span>
                    <span className="start-when">{whenEdited(d.updatedAt)}</span>
                  </button>
                  <Menu label="⋯" title={`More for ${d.name}`} className="start-more" align="end">
                    {(close) => (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            close()
                            const name = window.prompt('Name this document', d.name)
                            if (name !== null) onChange(renameDoc(session, d.id, name))
                          }}
                        >
                          Rename…
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            close()
                            downloadBlob(new TextEncoder().encode(exportProject(d)), `${fileName(d.name)}.json`, 'application/json')
                          }}
                        >
                          Export project
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            close()
                            if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return
                            onChange(deleteDoc(session, d.id, crypto.randomUUID(), Date.now()))
                          }}
                        >
                          Delete…
                        </button>
                      </>
                    )}
                  </Menu>
                </li>
              ))}
            </ul>
            {!durable && (
              <p className="start-durability">
                This browser may evict local data when it needs space. Export anything you want to keep.
              </p>
            )}
          </section>

          <section>
            <div className="start-section-head">
              <h2>Examples</h2>
            </div>
            <div className="start-examples">
              {EXAMPLES.map((ex) => (
                <button
                  type="button"
                  key={ex.slug}
                  className="start-example"
                  onClick={() => create(suggestName(ex.source, session.docs.map((d) => d.name)), ex.source, { edit: 'params' })}
                >
                  <img src={`${import.meta.env.BASE_URL}examples/${ex.slug}.jpg`} alt="" />
                  <span>{title(ex.name)}</span>
                </button>
              ))}
            </div>
            <p className="start-note">Each example is a plain .scad file that also opens in desktop OpenSCAD.</p>
          </section>
        </div>
      </div>
      <p className="start-footer">
        <a
          href={__APP_COMMIT__ ? `${REPO_URL}/commit/${__APP_COMMIT__}` : `${REPO_URL}/releases/tag/${__APP_VERSION__}`}
          target="_blank"
          rel="noreferrer"
        >
          {__APP_VERSION__}
        </a>
        <span aria-hidden="true"> · </span>
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span aria-hidden="true"> · </span>
        <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
          GPL-3.0
        </a>
      </p>
    </div>
  )
}
