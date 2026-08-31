import { useEffect } from 'react'
import { COMMANDS } from '../chat/commands'

/**
 * The manual. Static JSX rather than markdown through chat/markdown.ts: that
 * parser is built for streaming replies — it drops code bodies and flattens
 * headings — and this page is the one place a table and real headings matter.
 * The command table is rendered from COMMANDS, so it cannot drift from /help.
 */
export function Help({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="help" role="dialog" aria-labelledby="help-title">
      <article className="help-card">
        <div className="help-head">
          <h1 id="help-title">How to use Vibe3D</h1>
          <button type="button" className="help-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <p className="help-lede">
          A chat, a source editor and a 3D viewport over one OpenSCAD document. Everything runs in
          this browser; the only thing that leaves it is the chat request to OpenRouter, with your
          key.
        </p>

        <h2>Getting started</h2>
        <ul>
          <li>
            <b>A key.</b> Open the settings from the model name under the chat. <b>Connect
            OpenRouter</b> mints a key scoped to this app that you can revoke on its own; pasting a
            key works too. It is kept in this browser only and sent to exactly one host.
          </li>
          <li>
            <b>A document.</b> The start window lists yours, newest first, with two examples to
            start from. <b>New</b> in the menu bar makes an empty one.
          </li>
          <li>
            <b>A part.</b> Describe it in the chat: what it is for, the dimensions that matter,
            what it mates with. Unstated dimensions are the model's guess — it will say which.
          </li>
        </ul>

        <h2>What happens on a turn</h2>
        <p>
          The model replies with the complete source, or with an edit that replaces a section of
          it. The browser compiles it; a compile error goes back to the model verbatim for up to
          two repairs. Once the source compiles, the model gets one look at the result — a
          measured report and, for vision models, a before/after render — and answers a few
          yes/no questions about your request before the turn commits. It may reply with one
          correction. Everything it saw sits in the transcript behind the <b>inspected</b> chip.
        </p>
        <p>
          <b>Stop</b> aborts the request. If a version had already compiled, you keep it. Prices
          in the footer are OpenRouter's list prices for the session so far.
        </p>

        <h2>The editor</h2>
        <p>
          Edit freely; a successful compile of your edits becomes a version. Assignments above the
          first <code>{'{'}</code> with a Customizer annotation become controls under the editor —
          <code>wall = 2; // [1:0.5:5]</code> is a slider, <code>// [a, b, c]</code> a dropdown,{' '}
          <code>true</code> a checkbox. Dragging previews at a reduced <code>$fn</code> and writes
          the value into the source on release, with no model call.
        </p>

        <h2>The viewport</h2>
        <ul>
          <li>Drag to orbit, wheel to zoom, right-drag to pan. The cube snaps to a standard view; <b>FIT</b> frames the part.</li>
          <li>
            The tags read size, triangle count, part count and volume off the mesh. <i>Not
            watertight</i> means the mesh has an open edge and will trouble a slicer. The
            <b> metric</b>/<b>imperial</b> toggle changes the readout only — the source is always
            millimetres — and tells the model how to read your dimensions.
          </li>
          <li>
            <b>Click a part</b> to select it: it is highlighted, a chip appears above the composer,
            and your next message is headed by that part's number, size, position and colour, so
            "make this taller" means that one. Click empty space or <b>clear</b> to deselect.
          </li>
          <li><b>Export 3MF</b> (carries units, one object per part), <b>STL</b>, or <b>OBJ</b>.</li>
        </ul>

        <h2>Parts</h2>
        <p>
          Every top-level statement in the source is a part of its own: shown together, counted in
          the tags, and a separate object in the 3MF — a box and its lid arrive in the slicer as two
          things. The model is told to lay parts out side by side on the plate, never overlapping,
          and to keep a single solid's union inside a module.
        </p>

        <h2>Imported meshes</h2>
        <p>
          <b>Import mesh…</b> under the sliders takes an STL, OBJ, 3MF or OFF file. The kernel reads
          and measures it; a file it cannot read is refused with its reason. From then on{' '}
          <code>import("name.stl")</code> works in the source, and the model sees the file with its
          bounding box so it can place it by numbers. Files stay with the document in this browser
          and travel in the project file.
        </p>

        <h2>Reference images</h2>
        <p>
          Paste an image into the composer or pick one with the button beside it, up to four per
          message. They carry layout and intent; dimensions still have to come from your words. An
          image is sent with the turn it belongs to and never again, and it is not saved.
        </p>

        <h2>Versions and documents</h2>
        <p>
          Every turn, every <b>Save version</b> and every successful compile of your own edits is a
          version; nothing is deleted. The picker in the menu bar steps to any of them,{' '}
          <code>/undo</code> steps back one, and a change made from an older version simply becomes
          the next. <b>Export project</b> writes one <code>.json</code> with source, versions,
          conversation and meshes — never the key; <b>Import project</b> reads it back as a new
          document. Documents live in this browser's storage, which a browser may evict when it
          needs space: export what you want to keep.
        </p>

        <h2>Commands</h2>
        <p>Type them in the chat.</p>
        <table>
          <tbody>
            {COMMANDS.map((c) => (
              <tr key={c.usage}>
                <td>{c.usage}</td>
                <td>{c.what}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Keys</h2>
        <ul>
          <li><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> breaks a line.</li>
          <li><kbd>Esc</kbd> closes this page.</li>
          <li>The editor has its own undo; a turn's rewrite is one step of it.</li>
        </ul>
      </article>
    </div>
  )
}
