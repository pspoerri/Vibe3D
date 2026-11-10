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
          this browser; the only thing that leaves it is the chat request to the model host you
          connect, with your key.
        </p>

        <h2>Getting started</h2>
        <ul>
          <li>
            <b>A key.</b> Send a first message and the app asks for one, or open <b>Settings</b> at
            the top of the chat. <b>Connect OpenRouter</b> mints a key scoped to this app that you
            can revoke on its own; pasting a key works too. <b>Local server</b> takes the address of
            an OpenAI-compatible server on your machine (Ollama, LM Studio) instead — that one needs
            the app run from source with <code>pnpm dev</code>, because a built copy, the hosted site
            included, may only talk to OpenRouter.
            A key is kept in this browser only and sent to exactly one host.
          </li>
          <li>
            <b>A document.</b> Type what you want to print on the start window and it becomes one.
            The start window also lists yours, newest first, with three examples to start from;{' '}
            <b>New document</b> in the menu under a document's name makes an empty one.
          </li>
          <li>
            <b>A part.</b> Describe it in the chat: what it is for, the dimensions that matter,
            what it mates with. Unstated dimensions are the model's guess — it will say which.
          </li>
        </ul>

        <h2>What happens on a turn</h2>
        <p>
          The model replies with the complete source, with <code>openscad-part</code> blocks that
          replace whole PART sections or whole modules by name, or with an edit that replaces a
          quoted section. The browser
          compiles it; a compile error goes back to the model verbatim for up to two repairs.
        </p>
        <p>
          With <b>Thinking</b> set to <b>Off</b> that is the whole turn: one model call. Set it
          to Low, Medium or High — a model starts at High — under the composer, in Settings, or
          with <code>/think</code>, and the model also checks its work before the turn commits:
        </p>
        <ul>
          <li>
            <b>It looks.</b> After each compile it gets a measured report and, for vision models, a
            render. It answers a few yes/no questions about your request, and may correct itself,
            ask for another angle or a cut through the part, and look again, until it is satisfied.
          </li>
          <li>
            <b>The app grades the mechanics</b> itself — rests on the plate, one solid per PART, no
            sealed voids, watertight, overhangs past 45°, fits the bed, lettering in its own
            colour — and hands the model the verdicts. Kernel warnings from a compile that
            succeeded go to it too, and show under the viewport in amber.
          </li>
          <li>
            <b>You can watch.</b> The line under the transcript says what it is doing —{' '}
            <code>look 2 · compiling</code> — and what the turn has cost so far; click it for the
            model's raw output. The viewport shows each version that compiles, tagged{' '}
            <b>candidate</b> until it commits.
          </li>
          <li>
            <b>It is all kept.</b> What it saw sits in the transcript in the <b>Checked its work</b>{' '}
            card, and each turn ends in a card naming the version it made, with <b>Changes</b>{' '}
            opening it in History.
          </li>
        </ul>
        <p>
          At any thinking level the model can load a <b>skill</b> — fonts, views, parts, diff,
          bosl2 — reference it pulls in when it needs it; a <b>skill · fonts</b> chip marks the
          moment.
        </p>
        <p>
          <b>Stop</b> aborts the request, and is the only thing that interrupts a turn. If a version
          had already compiled, you keep it. The chat's header shows what the session has cost at
          the model's list price. <b>Copy debug report</b> in Settings puts settings, source and the
          whole raw transcript on the clipboard — no key, no images — for a bug report.
        </p>

        <h2>The editor</h2>
        <p>
          The edit pane holds <b>Parameters</b> and <b>Code</b> as two tabs. It starts closed, opens
          from the button at the viewport's edge, resizes by dragging that edge, and stays as you
          left it. On a phone the three panes are tabs: Model, Chat and Edit.
        </p>
        <p>
          Edit freely; a successful compile of your edits becomes a version. Assignments above the
          first <code>{'{'}</code> with a Customizer annotation become controls on the <b>Parameters</b> tab —
          <code>wall = 2; // [1:0.5:5]</code> is a slider, <code>// [a, b, c]</code> a dropdown,{' '}
          <code>true</code> a checkbox. Dragging previews at a reduced <code>$fn</code> and writes
          the value into the source on release, with no model call. A compile error marks its line
          in the editor.
        </p>
        <p>
          <b>BOSL2</b> is installed: <code>include &lt;BOSL2/std.scad&gt;</code> at the top of the
          file gives <code>cuboid()</code> with rounding and chamfers, <code>cyl()</code>,{' '}
          <code>tube()</code>, anchors and attachments; <code>threading.scad</code>,{' '}
          <code>gears.scad</code> and <code>screws.scad</code> add threads, gears and screw holes.
          It is loaded only for a source that names it. The model is told to use it for fillets,
          threads and gears.
        </p>

        <h2>The viewport</h2>
        <ul>
          <li>Drag to orbit, wheel to zoom, right-drag to pan. The cube snaps to a standard view; <b>Fit view</b> frames the part. The tools are in the dock at the bottom of the view.</li>
          <li>
            The readout at the top of the view gives the mesh's size, part count and volume, and whether it
            fits your printer. <i>Not watertight</i> means the mesh has an open edge and will trouble
            a slicer. The <b>mm</b>/<b>in</b> toggle changes the readout only — the source is always
            millimetres — and tells the model how to read your dimensions.
          </li>
          <li>
            <b>Click a part</b> to select it: it is highlighted, a chip appears above the composer,
            and your next message is headed by that part's number, size, position and colour, so
            "make this taller" means that one. Click empty space or the chip's <b>×</b> to deselect.
          </li>
          <li>
            <b>Sketch</b> turns the view into a sketchpad: drag to draw in red, <b>Undo</b> and{' '}
            <b>Clear</b> fix a stroke, <b>Attach to message</b> puts the marked-up view into your next message,
            where the model reads the strokes as "here". <kbd>Esc</kbd> leaves without attaching.
          </li>
          <li>
            <b>Section</b> opens the part along X, Y or Z; the slider moves the cut, so a pocket or a
            wall thickness can be seen. <b>Measure</b> takes two clicks on the part and shows the
            distance with its axis deltas. <b>Done</b>, <kbd>Esc</kbd> or <b>Select</b> leaves either.
          </li>
          <li>
            The plate outline is the printer's build volume — <b>Printer</b> in Settings, a preset or
            your own numbers, 256 mm cubed by default — and the model is told when the part does not
            fit it.
          </li>
          <li>
            <b>Export</b> offers <b>3MF</b> (carries units, one object per part, and every <code>color()</code> as a
            material — and, for Bambu Studio and PrusaSlicer, as painting: each colour region is
            a filament slot, the largest region filament 1), <b>STL</b> (colours per facet, the VisCAM/SolidView
            way — MeshLab reads them, slicers ignore them), or <b>OBJ</b> (a coloured model brings
            a <code>.mtl</code> file along, one material per colour, which slicers read). Bambu
            Studio greets every 3MF it did not write itself — Fusion's and PrusaSlicer's included —
            with "invalid config, load geometry data only": click OK, the parts and colours all
            load. Only a full Bambu project file avoids it, and that would carry printer settings
            this app should not choose for you. With a part selected, Export offers that part
            alone.
          </li>
        </ul>

        <h2>Parts</h2>
        <p>
          Every top-level statement in the source is a part of its own: shown together, counted in
          the readout, and a separate object in the 3MF — a box and its lid arrive in the slicer as two
          things. The model is told to lay parts out side by side on the plate, never overlapping,
          and to keep a single solid's union inside a module.
        </p>
        <p>
          The source keeps each part between <code>// ---- PART 1 ----</code> and{' '}
          <code>// ---- PART 1 END ----</code>, one top-level call per section, so part 1 in the
          viewport is PART 1 in the source and the model can replace one section without touching
          the rest. After a compile the chat notes a section with no top-level call, a call outside
          every section, or a module nothing calls.
        </p>
        <p>
          <b>Construction geometry</b> — the shelf a bracket hangs on, the box a lid must fit, a
          clearance zone — lives in a <code>// ---- CONSTRUCTION ----</code> section after the
          parts, every statement prefixed with OpenSCAD's <code>%</code> modifier. It shows as a
          translucent blue ghost in the viewport and in the model's own looks, and it is never in
          the readout, the exports or a print. Ask for it: "the bracket hangs on a 18 mm shelf — show
          the shelf".
        </p>

        <h2>Imported meshes</h2>
        <p>
          <b>Import STL, OBJ, 3MF or OFF</b> on the Parameters tab takes a mesh file. The kernel reads
          and measures it; a file it cannot read is refused with its reason. From then on{' '}
          <code>import("name.stl")</code> works in the source, and the model sees the file with its
          bounding box so it can place it by numbers. Files stay with the document in this browser
          and travel in the project file.
        </p>

        <h2>Reference images</h2>
        <p>
          Paste an image into the composer or pick one with the button beside it, up to four per
          message. They carry layout and intent; dimensions still have to come from your words. An
          image is sent with the turn it belongs to and never again, and it is not saved. A view
          attached from <b>Sketch</b> travels the same way, headed so the model knows it is this app's
          own render with your strokes on it.
        </p>

        <h2>Versions and documents</h2>
        <p>
          Every turn, every <b>Save version</b> and every successful compile of your own edits is a
          version; nothing is deleted. <b>History</b>, the <code>v7</code> pill beside the document's
          name, lists them: open one to see what it changed against the version it was made from,
          and <b>Restore</b> it or read the <b>Full diff</b>. <code>/undo</code> steps back one, and a
          change made from an older version simply becomes the next. <b>Share</b> copies a link with the source in it; whoever opens it gets a new
          document with that source and no conversation. The start window shows a thumbnail of
          each document's last compile. <b>Export project</b>, in the menu under the document's name, writes one <code>.json</code> with source, versions,
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
          <li><kbd>Esc</kbd> closes this page, and leaves Sketch, Section and Measure.</li>
          <li>The editor has its own undo; a turn's rewrite is one step of it.</li>
        </ul>
      </article>
    </div>
  )
}
