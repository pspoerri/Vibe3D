# Vibe3D

**Prompt a parametric 3D model - with your own tokens.**

Describe a part. The model writes OpenSCAD, your browser compiles it, and you get a mesh you can
orbit and export as STL, 3MF or OBJ. You can also just write the OpenSCAD yourself, or drag the
sliders that the source's own parameters produce — those cost nothing at all.

OpenSCAD is the prompting language on purpose: it has roughly 25× the public corpus of any
alternative, so a model writes it fluently and zero-shot, and it is code you can read, edit and
diff rather than a mesh you can only accept or reject.

Everything runs in the browser. There is no backend — the kernel is OpenSCAD compiled to
WebAssembly, the renderer is three.js, and the only thing that leaves your machine is the chat
request to the model host you configured.

**Live: <https://spoerri.dev/Vibe3D/>**

Design: [docs/design.md](docs/design.md) · Plans: [docs/superpowers/plans](docs/superpowers/plans)

## Bring your own tokens

The model runs on [OpenRouter](https://openrouter.ai), with your key. Two ways to give it one:

- **Connect OpenRouter** runs an OAuth PKCE flow and mints a key scoped to this app, which you
  can revoke without touching the rest of your account.
- **Paste a key** works too.

The key is stored in this browser's `localStorage` under `vibe3d.key`, on its own, and it is sent
to exactly one place: the model host you configured. Revoke it any time at
<https://openrouter.ai/settings/keys>; the settings panel links to the specific key. **This app
cannot set a spend cap** — that is a manual step in your OpenRouter settings. The chat footer
shows what the session has cost so far, at the model's list price.

Any script running on the page could read the key; that is inherent to browser storage, not a
choice this app made. The mitigation is a strict Content-Security-Policy whose `connect-src`
allows only OpenRouter, plus keeping the dependency list short. That allowlist is also why only
OpenRouter works as a host in the deployed build.

One honest note about **Stop**: aborting the request stops billing on OpenAI, Anthropic, DeepSeek
and xAI, but not on Google, Groq or Mistral, which bill the whole completion once it starts.

## Units

The source, the kernel and the exported file are always millimetres — that is what OpenSCAD
speaks. The metric/imperial toggle changes the readout, and it tells the model how to read *you*:
in imperial, "a two inch knob" means 50.8 mm in the source it writes.

## Examples, colour and names

The start window offers three example models — a mounting plate, a potted plant and a Biergarten
sign — from [`src/examples`](src/examples); each is a plain `.scad` file that also opens in desktop
OpenSCAD. A link opens one straight away as a new document: `#example=mounting-plate`,
`#example=potted-plant` or `#example=biergarten-sign` on the app's URL.
`color()` in the source is what the viewport shows, per face, through unions and differences.
A document is named after your first prompt while the model works, then after the title comment
the model puts on the first line of the file; **Rename** makes a title yours for good.

## Parts and imported meshes

Every top-level statement in the source is a part of its own: they are shown together, the HUD
counts them, and the 3MF carries each as a separate object — with its `color()` — so the slicer
sees a box and its lid as two things. The model is told to lay parts out side by side on the plate
and never to let two top-level statements overlap; a single solid keeps its union inside a module.

Meshes you already have go in under the sliders: **Import mesh…** takes an STL, OBJ, 3MF or OFF,
the kernel reads and measures it, and from then on `import("name.stl")` works in the source. The
model sees the list with each file's bounding box and places it by those numbers. The files live
with the document in this browser and travel in the project file.

The source keeps each part between `// ---- PART 1 ----` and `// ---- PART 1 END ----` markers,
one top-level call per section, so part 1 in the viewport is PART 1 in the source and the model
can replace one section without touching the rest. After a compile the chat notes a section with
no top-level call, a call outside every section, or a module nothing calls.

Click a part in the viewport to select it. The next message you send is headed by that part's
number, bounding box and colour, so "make this 2 mm taller" means the one you clicked.

**Construction geometry** — the shelf a bracket hangs on, the box a lid must fit — goes in a
`// ---- CONSTRUCTION ----` section, every statement prefixed with OpenSCAD's `%` modifier. It
shows as a translucent blue ghost in the viewport and in the model's own looks, and is never in
the tags, the exports or a print; the chat notes a construction statement that forgot its `%`.

**DRAW** turns the viewport into a sketchpad: drag to draw in red, then **ATTACH** to put the
marked-up view into your next message — the model reads the strokes as "here", and your words say
what.

## Libraries

BOSL2 is installed. `include <BOSL2/std.scad>` at the top of a file gives `cuboid()` with rounding
and chamfers, `cyl()`, `tube()`, anchors and attachments; `threading.scad`, `gears.scad` and
`screws.scad` add threads, gears and screw holes. The library is written into the kernel only for
a source that names it, so a plain part pays nothing. It is fetched from GitHub at a pinned commit
when you install, and again before a build if it is missing; bump the pin in
`scripts/fetch-bosl2.mjs`. The model is told to reach for it for
fillets, threads and gears, and a `bosl2` skill lists the calls.

## Local skill

The same loop for a model that runs on your machine — Claude Code, or anything that reads a
`SKILL.md` and runs a shell command. `pnpm build:skill` writes a self-contained directory to
`dist/skill`: copy it wherever skills live (`cp -r dist/skill ~/.claude/skills/vibe3d`, or into a
sandbox) and it needs only `bun`, plus Chrome or Chromium for renders. `vibe3d check` prints the
measured report and the app's checks, `vibe3d look` a named view, cut or before/after composite,
`vibe3d export` a 3MF, STL or OBJ, and `vibe3d prompt` the modelling rules the app gives its own
model. The skill's `SKILL.md` is the loop. Its tests in `pnpm test` skip their render cases unless
`bun` is on PATH, and unless Chrome is found.

## Partial updates

For a small change to a large file the model can reply with an edit block that replaces just the
lines it quotes, or with a part block that replaces one PART section — or one module, by name —
whole, instead of rewriting the source. An edit has to match exactly one place, a part block has to
name a section that exists (or the next number, to add one) or a module (an unknown name adds it);
one that does not is reported back to the model like a compile error and costs it a repair
attempt, so nothing is ever applied half-way.

## Reference images

Paste an image into the composer, or pick one with the button beside it — up to four per message.
They carry layout, proportion and intent; **the dimensions still have to come from your words**,
because models read sizes off pixels badly, and the model dropdown marks which models can read an
image at all. An image is sent with every model call of the turn you attach it to — its repairs
and its looks — and with no later turn. The app's own renders are cheaper still: only the newest
one of a turn rides along. The images are not saved — the conversation is, without them.

## Thinking, and checking its work

With thinking **off** — the default, and `/think off` — a message is one model call: the reply is
compiled, repaired if it has to be, and committed.

Valid code of the wrong shape is the failure that actually happens, so with thinking on (`low`,
`medium` or `high`, which is also the reasoning effort the model is asked for) every source that
compiles gets a look before the turn commits: a measured report (bounding box, volume, part
count, genus, overhang share, whether it fits the bed, and what was added and removed compared
with the part that was on screen) and —
for models that can read an image — a before/after render, green over magenta. The model answers
a few yes/no questions about your request from those numbers and may correct itself, ask for
another angle or a cut through the part, and look again, until it says the part is right. A
status line under the transcript says what it is doing — `look 2 · rendering front view, cut at
z = 12 mm` — and the reports and pictures sit in the transcript behind the **inspected** chips.
Nothing interrupts it but **Stop**, which keeps the last version that compiled.

## Viewport tools

**CUT** opens the part along X, Y or Z with a slider, so a pocket or a wall thickness can be seen.
**MEASURE** takes two clicks on the part and shows the distance with its axis deltas. With a part
selected, the export buttons write that part alone. The printer's build volume is a setting
under the chat (the plate outline follows it), and the model is told when the part does not fit.

## Versions

Every LLM turn, every **Save version** and every successful compile of your own edits is a version
of the document, and nothing is ever deleted: the picker in the menu bar steps to any of them,
`/undo` steps back one, **Diff** shows what the current one changed, and a change made from an
older version simply becomes the next one. **Share** copies a link with the source in it; opening
the link makes a new document.
Documents, their versions and their conversations live in this browser's IndexedDB. **Export
project** writes one `.json` you can keep or import anywhere; it never contains the key.

## Layout and help

The editor and chat panes resize from the grip at their bottom corner (the browser's own); the
viewport takes what is left. **Help** in the menu bar lists the chat commands on hover and opens
the manual on click; `/help` prints the same list in the transcript.

## Licensing

GPL-3.0-or-later. This project bundles the OpenSCAD WebAssembly build, which is
GPL-2.0-or-later and links Manifold (Apache-2.0), and the Liberation fonts (SIL OFL 1.1); the
build fetches the BOSL2 library (BSD-2-Clause). GPL-3.0 is the compatible combination. OpenSCAD is © the OpenSCAD developers — https://openscad.org/

## Development

    pnpm install
    pnpm dev

    pnpm test    # unit tests, node env
    pnpm e2e     # Playwright, against the real built artifact
    pnpm build   # type-check + production build

    OPENROUTER_API_KEY=sk-or-… pnpm eval   # the harness against a real model, ten parts, under Node
    EVAL_MODEL=anthropic/claude-sonnet-5 EVAL_THINKING=off EVAL_ONLY=knob pnpm eval
