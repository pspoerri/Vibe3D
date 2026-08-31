import { useState } from 'react'
import { Compiler } from '../kernel/compile'
import { parseOff } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import { COMPONENT_NAME, type Component } from '../state/documents'
import { formatLength, lengthLabel, type Units } from '../state/units'

/** ponytail: one cap for the store and the kernel FS alike. Raise it when a real part needs more. */
const MAX_BYTES = 64 * 1024 * 1024

/**
 * The document's mesh files, under the sliders. Attaching one is a compile:
 * `import()` on a fresh kernel is both the validation — the kernel's own
 * error names what is wrong with the file — and the measurement the model
 * places the part by (design.md §8).
 */
export function ComponentsPanel({
  components,
  units,
  disabled,
  onAdd,
  onRemove,
}: {
  components: readonly Component[]
  units: Units
  disabled: boolean
  onAdd: (component: Component) => void
  onRemove: (name: string) => void
}) {
  const [reading, setReading] = useState<string | null>(null)

  const attach = async (file: File) => {
    const { name } = file
    if (!COMPONENT_NAME.test(name)) {
      window.alert(`"${name}" is not a mesh file name: letters, digits, dots, dashes, and .stl, .obj, .3mf or .off.`)
      return
    }
    if (file.size > MAX_BYTES) {
      window.alert(`"${name}" is ${Math.round(file.size / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB.`)
      return
    }
    setReading(name)
    const compiler = new Compiler()
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // The name passed COMPONENT_NAME, so it is safe inside a string literal.
      const result = await compiler.compile(`import("${name}");`, 'off', { files: { [`/${name}`]: bytes } })
      if (!result.ok) {
        window.alert(`${name} could not be read:\n${result.stderr}`)
        return
      }
      const stats = meshStats(parseOff(new TextDecoder().decode(result.data)))
      onAdd({ name, bytes, min: stats.min, max: stats.max })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      compiler.dispose()
      setReading(null)
    }
  }

  return (
    <div className="components" data-disabled={disabled}>
      {components.map((c) => (
        <span className="component" key={c.name} title={`import("${c.name}")`}>
          <span className="component-name">{c.name}</span>
          <span className="component-size">
            {c.max.map((hi, i) => formatLength(hi - c.min[i]!, units)).join(' × ')} {lengthLabel(units)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${c.name}`}
            disabled={disabled}
            onClick={() => onRemove(c.name)}
          >
            ×
          </button>
        </span>
      ))}
      <label className="component-add">
        {reading ? `Reading ${reading}…` : 'Import mesh…'}
        <input
          type="file"
          aria-label="Import mesh"
          accept=".stl,.obj,.3mf,.off"
          disabled={disabled || reading !== null}
          onChange={(e) => {
            const file = e.target.files?.[0]
            // So the same file can be picked twice in a row.
            e.target.value = ''
            if (file) void attach(file)
          }}
        />
      </label>
    </div>
  )
}
