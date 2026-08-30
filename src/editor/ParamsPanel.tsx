import { useMemo, useState } from 'react'
import { defineFor, DRAG_FN, scanParams, setParam, type Param } from './params'

/**
 * Customizer strip: the source's own annotated parameters, as controls.
 *
 * Dragging costs zero LLM calls. It also costs zero document writes until
 * release — the drag previews by recompiling the UNTOUCHED source with `-D`
 * overrides at a reduced $fn, so a pointer move never rewrites the editor
 * buffer and never has to be undone.
 */
export function ParamsPanel({
  source,
  disabled,
  onPreview,
  onCommit,
}: {
  source: string
  disabled: boolean
  onPreview: (defines: readonly string[]) => void
  onCommit: (next: string) => void
}) {
  const params = useMemo(() => scanParams(source), [source])
  const [draft, setDraft] = useState<{ name: string; value: number } | null>(null)

  if (params.length === 0) return <></>

  const preview = (param: Param, value: number) => {
    setDraft({ name: param.name, value })
    // $-variables are excluded from the panel, so the $fn override can never
    // collide with the dragged parameter's own define.
    onPreview([defineFor(param.name, value), defineFor('$fn', DRAG_FN)])
  }

  const commit = (param: Param, value: number | boolean | string) => {
    setDraft(null)
    onPreview([])
    const next = setParam(source, param, value)
    // setParam returns the input unchanged when its re-scan does not confirm
    // the write. Committing that would be a no-op edit that recompiles.
    if (next !== source) onCommit(next)
  }

  const shown = (param: Param): number =>
    draft?.name === param.name ? draft.value : Number(param.value)

  let group = ''
  return (
    <div className="params" data-disabled={disabled}>
      {params.map((param) => {
        const header = param.group !== group ? ((group = param.group), param.group) : null
        return (
          <div key={param.name}>
            {header && <div className="params-group">{header}</div>}
            <div className="param">
              <label htmlFor={`param-${param.name}`} title={param.caption}>
                {param.caption || param.name}
              </label>

              {param.kind === 'bool' && (
                <input
                  id={`param-${param.name}`}
                  type="checkbox"
                  checked={param.value}
                  disabled={disabled}
                  onChange={(e) => commit(param, e.target.checked)}
                />
              )}

              {param.kind === 'enum' && (
                <select
                  id={`param-${param.name}`}
                  value={String(param.value)}
                  disabled={disabled}
                  onChange={(e) => {
                    const chosen = param.options.find((o) => String(o.value) === e.target.value)
                    commit(param, chosen ? chosen.value : e.target.value)
                  }}
                >
                  {param.options.map((option) => (
                    <option key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}

              {param.kind === 'number' && param.range && (
                <>
                  <output htmlFor={`param-${param.name}`}>{shown(param)}</output>
                  <input
                    id={`param-${param.name}`}
                    type="range"
                    min={param.range.min}
                    max={param.range.max}
                    step={param.range.step}
                    value={shown(param)}
                    disabled={disabled}
                    onChange={(e) => preview(param, e.target.valueAsNumber)}
                    onPointerUp={() => draft && commit(param, draft.value)}
                    onKeyUp={() => draft && commit(param, draft.value)}
                    onBlur={() => draft && commit(param, draft.value)}
                  />
                </>
              )}

              {param.kind === 'number' && !param.range && (
                <input
                  id={`param-${param.name}`}
                  type="number"
                  value={shown(param)}
                  disabled={disabled}
                  onChange={(e) => setDraft({ name: param.name, value: e.target.valueAsNumber })}
                  onBlur={() => draft && commit(param, draft.value)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
