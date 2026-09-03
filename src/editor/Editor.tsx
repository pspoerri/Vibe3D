import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { openscad } from './openscad-mode'

/**
 * Marks a transaction as driven by `value` rather than by the user.
 *
 * Without it the external-value effect below dispatches a whole-document
 * replace, the updateListener sees docChanged and calls onChange, and the new
 * value goes straight back to the parent as if the user had typed it. In
 * Milestone 1 that path never ran — nothing but `source` ever set `value`, so
 * the `current === value` guard always short-circuited — but streaming a
 * model's source into the editor makes it the primary path.
 *
 * `editable` and `EditorState.readOnly` do NOT close this: per CodeMirror's own
 * docs, editable "doesn't affect API calls that change the editor content".
 */
const External = Annotation.define<boolean>()

const editableExtensions = (editable: boolean) => [
  EditorState.readOnly.of(!editable),
  EditorView.editable.of(editable),
]

const errorMark = Decoration.line({ class: 'cm-error-line' })

/** The line the kernel's error names, tinted; nothing when there is none or it is off the end. */
const errorExtension = (line: number | null) =>
  EditorView.decorations.compute(['doc'], (state) =>
    line === null || line < 1 || line > state.doc.lines
      ? Decoration.none
      : Decoration.set([errorMark.range(state.doc.line(line).from)]),
  )

/** `line N` in the kernel's stderr, as it names the parser or evaluation error's line. */
export function errorLineOf(stderr: string | null): number | null {
  const m = stderr && /\bline (\d+)/.exec(stderr)
  return m ? Number(m[1]) : null
}

export function Editor({
  value,
  onChange,
  editable,
  errorLine = null,
}: {
  value: string
  onChange: (next: string) => void
  /** false while a turn owns the document. The doc stays selectable and copyable. */
  editable: boolean
  /** The line the last compile error named, 1-based; marked in the gutter and the text. */
  errorLine?: number | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep the latest callback without tearing down the editor on every render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editableRef = useRef(editable)
  editableRef.current = editable
  const editableConf = useMemo(() => new Compartment(), [])
  const errorConf = useMemo(() => new Compartment(), [])
  const errorLineRef = useRef(errorLine)
  errorLineRef.current = errorLine

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          indentOnInput(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          openscad(),
          editableConf.of(editableExtensions(editableRef.current)),
          errorConf.of(errorExtension(errorLineRef.current)),
          // A StreamLanguage only tags tokens; without this nothing styles them.
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.theme({
            '&': { height: '100%' },
            // Tighter than CodeMirror's default: this pane is read as a whole
            // part, so lines per screen matters more than comfortable prose
            // leading, and the model writes 40-line documents.
            '.cm-scroller': { fontFamily: 'ui-monospace, monospace', lineHeight: '1.38' },
            '.cm-content': { fontSize: '12.5px' },
            '.cm-gutters': { fontSize: '11px', background: 'transparent', border: 'none', color: '#a8ada6' },
            '.cm-activeLine': { background: '#00000006' },
            '.cm-activeLineGutter': { background: 'transparent', color: '#6a706a' },
            '.cm-error-line': { background: '#a8256b18', boxShadow: 'inset 3px 0 0 #a8256b' },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (update.transactions.some((tr) => tr.annotation(External) === true)) return
            onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mount once. External value changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply externally-driven changes (Milestone 2's full-source rewrites) via a
  // transaction rather than a remount, guarded so we never fight the user's typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: External.of(true),
      // A whole-document replace clobbers the selection either way; this at
      // least keeps the tail of a streaming source in view.
      effects: EditorView.scrollIntoView(value.length),
    })
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableConf.reconfigure(editableExtensions(editable)),
    })
  }, [editable, editableConf])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: errorConf.reconfigure(errorExtension(errorLine)) })
  }, [errorLine, errorConf])

  return <div ref={hostRef} style={{ height: '100%', overflow: 'hidden' }} />
}
