# Vibe3D

**Prompt a parametric 3D model - with your own tokens.**

You describe a part. The model writes OpenSCAD, your browser compiles it, and you get a mesh you
can orbit and export as STL, 3MF or OBJ. You can also write the OpenSCAD yourself, or drag the
sliders that the source's parameters produce. Neither of those costs anything.

OpenSCAD is the prompting language on purpose. It has roughly 25× the public corpus of any
alternative, so a model writes it fluently without examples. It is also code you can read, edit
and diff, where a mesh is something you can only accept or reject.

Everything runs in the browser, and there is no backend. The kernel is OpenSCAD compiled to
WebAssembly and the renderer is three.js. The only thing that leaves your machine is the chat
request to the model host you configured.

**Live: <https://vibe3d.spoerri.dev/>**

Design: [docs/design.md](docs/design.md) · Plans: [docs/superpowers/plans](docs/superpowers/plans)

## Quick start

1. Open the app and type what you want to print. Say what it is for, which dimensions matter and
   what it mates with.
2. Your first message asks for a key. Click **Connect OpenRouter**, or paste a key.
3. Orbit the result, drag its sliders on the **Parameters** tab and ask for changes. Then
   **Export** a 3MF for your slicer.

**Help** in the top bar opens the manual. The sections below cover the same ground in more detail.

## Bring your own tokens

The model runs on your key. The first message you send without a key asks for one. **Settings**,
at the top of the chat, offers the same two tabs:

- **OpenRouter**: **Connect OpenRouter** runs an OAuth PKCE flow and mints a key scoped to this
  app. You can revoke that key without touching the rest of your account. You can also paste a
  key you already have, your own or a shared one. **Disconnect** forgets the key in this browser.
- **Local server**: this tab takes the base URL of any OpenAI-compatible server (Ollama, LM
  Studio, vLLM) and an optional key.

Each host's key is stored separately in this browser's `localStorage`: `vibe3d.key` for
OpenRouter and `vibe3d.key.other` for a local server. A key is sent to exactly one place, its own
host. You can revoke an OpenRouter key at any time at <https://openrouter.ai/settings/keys>, and
the settings panel links to the specific key. **This app cannot set a spend cap.** You have to
set one yourself in your OpenRouter settings. The chat's header shows what the session has cost
so far, at the model's list price.

Any script running on the page could read the key. That is inherent to browser storage, not a
choice this app made. The mitigation is a strict Content-Security-Policy whose `connect-src`
allows only OpenRouter, together with a short dependency list. The same allowlist means that
only OpenRouter works as a host in a build, the deployed one included. Run `pnpm dev` to use a
local server.

**Stop** aborts the request, but it does not stop billing everywhere. OpenAI, Anthropic, DeepSeek
and xAI stop charging when the request is aborted. Google, Groq and Mistral bill the whole
completion once it starts.

## Units

The source, the kernel and the exported file are always in millimetres, because that is what
OpenSCAD uses. The mm/in toggle in the viewport, which is also **Units** in Settings, changes the
readout. It also tells the model how to read your dimensions: in imperial, "a two inch knob"
becomes 50.8 mm in the source.

## Examples, colour and names

The start window offers three example models from [`src/examples`](src/examples): a mounting
plate, a potted plant and a Biergarten sign. Each is a plain `.scad` file that also opens in
desktop OpenSCAD. A link can open an example directly as a new document. Add
`#example=mounting-plate`, `#example=potted-plant` or `#example=biergarten-sign` to the app's
URL.

The viewport shows the colours that `color()` sets in the source. They apply per face and survive
unions and differences.

A document is named after your first prompt while the model works. After that it takes the title
comment that the model writes on the first line of the file. **Rename** fixes a title of your
own.

## Parts and imported meshes

Every top-level statement in the source is its own part. The parts are shown together, and the
viewport's readout counts them. The 3MF carries each part as a separate object with its
`color()`, so the slicer sees a box and its lid as two things. The model is told to lay parts out
side by side on the plate and never to let two top-level statements overlap. A single solid keeps
its union inside a module.

The source keeps each part between `// ---- PART 1 ----` and `// ---- PART 1 END ----` markers,
with one top-level call per section. Part 1 in the viewport is therefore PART 1 in the source,
and the model can replace one section without touching the rest. After a compile, the chat notes
any section with no top-level call, any call outside every section, and any module that nothing
calls.

Click a part in the viewport to select it. The next message you send starts with that part's
number, bounding box and colour, so "make this 2 mm taller" means the part you clicked.

You can bring meshes you already have. **Import STL, OBJ, 3MF or OFF** on the **Parameters** tab
takes a file, and the kernel reads and measures it. The mesh is placed in the source as a new
PART with `import("name.stl")`, so it shows at once. The model sees the list of files with each one's bounding box and places it by those
numbers. The files are stored with the document in this browser and are included in the project
file.

**Construction geometry** is reference geometry that must not print, such as the shelf a bracket
hangs on or the box a lid must fit. It goes in a `// ---- CONSTRUCTION ----` section, and every
statement in it starts with OpenSCAD's `%` modifier. It appears as a translucent blue ghost in
the viewport and in the model's own looks. It is never in the readout, the exports or a print.
The chat notes any construction statement that is missing its `%`.

**Sketch** turns the viewport into a sketchpad. Drag to draw in red, then click **Attach to
message** to add the marked-up view to your next message. The model reads the strokes as "here",
and your words say what to change.

## Libraries

BOSL2 is installed. `include <BOSL2/std.scad>` at the top of a file provides `cuboid()` with
rounding and chamfers, `cyl()`, `tube()`, anchors and attachments. `threading.scad`, `gears.scad`
and `screws.scad` add threads, gears and screw holes. The model is told to use BOSL2 for fillets,
threads and gears, and a `bosl2` skill lists the calls.

The library is written into the kernel only for a source that names it, so a plain part pays
nothing. It is fetched from GitHub at a pinned commit when you install, and again before a build
if it is missing. To update it, change the pin in `scripts/fetch-bosl2.mjs`.

## Local skill

The local skill offers the same loop to a model that runs on your machine, such as Claude Code or
anything else that reads a `SKILL.md` and runs shell commands. `pnpm build:skill` writes a
self-contained directory to `dist/skill`. Copy it to wherever your skills live, for example with
`cp -r dist/skill ~/.claude/skills/vibe3d`, or into a sandbox. It needs only `bun`, plus Chrome
or Chromium for renders.

| Command | What it does |
|---|---|
| `vibe3d check` | Prints the measured report and the app's checks. |
| `vibe3d look` | Renders a named view, a cut or a before/after composite. |
| `vibe3d export` | Writes a 3MF, STL or OBJ. |
| `vibe3d prompt` | Prints the modelling rules the app gives its own model. |

The skill's `SKILL.md` describes the loop. The skill's tests run with `pnpm test`. Their render
cases are skipped unless `bun` is on PATH and Chrome is found.

## Partial updates

For a small change to a large file, the model does not have to rewrite the source. It can reply
with an edit block, which replaces only the lines it quotes. It can also reply with a part block,
which replaces one whole PART section or one whole module by name.

An edit has to match exactly one place. A part block has to name an existing section, the next
free number to add a section, or a module. An unknown module name adds that module. A block that
breaks these rules is reported back to the model like a compile error and costs it one repair
attempt. Nothing is ever applied half-way.

## Reference images

Paste an image into the composer, or pick one with the button beside it. A message can carry up
to four. Images convey layout, proportion and intent, but **the dimensions still have to come
from your words**, because models read sizes off pixels badly. The model dropdown marks which
models can read an image at all.

An image is sent with every model call of the turn you attach it to, including that turn's
repairs and looks. It is not sent with any later turn. Of the app's own renders, only the newest
one of a turn is sent. Images are not saved. The conversation is saved without them.

## Thinking, and checking its work

**Thinking** is set under the composer and in Settings. At **Off**, or `/think off`, a message is
one model call. The reply is compiled, repaired if necessary, and committed.

The failure that actually happens is valid code of the wrong shape. At **Low**, **Medium** or
**High**, every source that compiles is therefore checked before the turn commits. The level is
also the reasoning effort the model is asked for, and a model starts at High. For each check the
model receives:

- **A measured report**: bounding box, volume, part count, genus, overhang share, whether the
  part fits the bed, and what was added and removed compared with the part that was on screen.
- **The app's own verdicts on the mechanics**: whether the part rests on the plate, has one solid
  per PART, has no sealed voids, is watertight, has acceptable overhangs, fits the bed, and has
  its lettering in its own colour.
- **A before/after render**, green over magenta, for models that can read an image.

The model answers a few yes/no questions about your request from those numbers. It may correct
itself, ask for another angle or a cut through the part, and look again, until it says the part
is right.

A status line under the transcript says what the model is doing, for example `look 2 · rendering
front view, cut at z = 12 mm`. The reports and pictures are collected in one **Checked its work**
card per turn. Each turn ends in a card that names the version it made and its size. **Changes**
on that card opens the version in History. Only **Stop** interrupts a turn, and it keeps the last
version that compiled.

## Viewport tools

The dock at the foot of the viewport holds **Select**, **Measure**, **Section** and **Sketch**.
The active tool's options appear above it.

- **Section** cuts the part open along X, Y or Z with a slider, so you can see a pocket or a wall
  thickness.
- **Measure** takes two clicks on the part and shows the distance with its axis deltas.
- **Export** offers 3MF, STL or OBJ, for the whole model or the part you clicked, and says
  whether it fits your printer.

You choose the printer under **Printer** in Settings, either a preset or your own build volume.
The plate outline follows it, and the model is told when the part does not fit.

## Versions

Every model turn, every **Save version** and every successful compile of your own edits becomes a
version of the document. Nothing is ever deleted. **History**, the version pill beside the
document's name, lists the versions with what each one changed, and offers **Restore** and
**Full diff**. `/undo` steps back one version. A change made from an older version becomes the
next version.

New, Rename, Delete and the project file are in the menu under the document's name. **Share**
copies a link that contains the source, and opening the link creates a new document.

Documents, their versions and their conversations are stored in this browser's IndexedDB.
**Export project** writes one `.json` file that you can keep or import anywhere. It never
contains the key.

## Layout and help

The edit pane holds **Parameters** and **Code** as two tabs. It starts closed for a new user,
resizes when you drag its edge, and stays as you left it. The chat pane resizes from the
browser's own grip at its bottom corner, and the viewport takes the remaining space. On a phone
the three panes become full-height tabs: Model, Chat and Edit.

**Help** in the top bar lists the chat commands on hover and opens the manual on click. `/help`
prints the same list in the transcript.

## Licensing

Vibe3D is licensed under GPL-3.0-or-later, which is compatible with everything it bundles:

- The OpenSCAD WebAssembly build is GPL-2.0-or-later and links Manifold (Apache-2.0).
- The Liberation fonts for `text()`, and Instrument Sans and IBM Plex Mono for the interface, are
  all SIL OFL 1.1. Their licences are in `src/fonts`.
- The build fetches the BOSL2 library (BSD-2-Clause).

OpenSCAD is © the OpenSCAD developers, <https://openscad.org/>.

## Development

    pnpm install
    pnpm dev

    pnpm test    # unit tests, node env
    pnpm e2e     # Playwright, against the real built artifact
    pnpm build   # type-check + production build

    OPENROUTER_API_KEY=sk-or-… pnpm eval   # the harness against a real model, ten parts, under Node
    EVAL_MODEL=anthropic/claude-sonnet-5 EVAL_THINKING=off EVAL_ONLY=knob pnpm eval
