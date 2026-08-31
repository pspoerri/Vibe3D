# Vibe3D

**Vibe 3D Models: Bring your own tokens.**
Leverages your LLM along with OpenSCAD to build your ideas into a 3D Model.

Describe a part. The model writes OpenSCAD, your browser compiles it, and you get a mesh you can
orbit and export as STL, 3MF or OBJ. You can also just write the OpenSCAD yourself, or drag the
sliders that the source's own parameters produce — those cost nothing at all.

OpenSCAD is the prompting language on purpose: it has roughly 25× the public corpus of any
alternative, so a model writes it fluently and zero-shot, and it is code you can read, edit and
diff rather than a mesh you can only accept or reject.

Everything runs in the browser. There is no backend — the kernel is OpenSCAD compiled to
WebAssembly, the renderer is three.js, and the only thing that leaves your machine is the chat
request to the model host you configured.

**Live: <https://pspoerri.github.io/Vibe3D/>**

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

The start window offers two example models — a mounting plate and a potted plant — from
[`src/examples`](src/examples); each is a plain `.scad` file that also opens in desktop OpenSCAD.
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
image at all. An image is sent with the turn you attach it to and with no later turn, so you pay
for it once — across that turn's repair attempts and its verification round, and never again. The images are not saved — the
conversation is, without them.

## Thinking, and checking its work

With thinking **off** — the default, and `/think off` — a message is one model call: the reply is
compiled, repaired if it has to be, and committed.

Valid code of the wrong shape is the failure that actually happens, so with thinking on (`low`,
`medium` or `high`, which is also the reasoning effort the model is asked for) every source that
compiles gets a look before the turn commits: a measured report (bounding box, volume, part
count, genus, and what was added and removed compared with the part that was on screen) and —
for models that can read an image — a before/after render, green over magenta. The model answers
a few yes/no questions about your request from those numbers and may correct itself, ask for
another angle or a cut through the part, and look again, until it says the part is right. A
status line under the transcript says what it is doing — `look 2 · rendering front view, cut at
z = 12 mm` — and the reports and pictures sit in the transcript behind the **inspected** chips.
Nothing interrupts it but **Stop**, which keeps the last version that compiled.

## Versions

Every LLM turn, every **Save version** and every successful compile of your own edits is a version
of the document, and nothing is ever deleted: the picker in the menu bar steps to any of them,
`/undo` steps back one, and a change made from an older version simply becomes the next one.
Documents, their versions and their conversations live in this browser's IndexedDB. **Export
project** writes one `.json` you can keep or import anywhere; it never contains the key.

## Layout and help

The editor and chat panes resize from the grip at their bottom corner (the browser's own); the
viewport takes what is left. **Help** in the menu bar lists the chat commands on hover and opens
the manual on click; `/help` prints the same list in the transcript.

## Licensing

GPL-3.0-or-later. This project bundles the OpenSCAD WebAssembly build, which is
GPL-2.0-or-later and links Manifold (Apache-2.0); GPL-3.0 is the compatible
combination. OpenSCAD is © the OpenSCAD developers — https://openscad.org/

## Development

    pnpm install
    pnpm dev

    pnpm test    # unit tests, node env
    pnpm e2e     # Playwright, against the real built artifact
    pnpm build   # type-check + production build
