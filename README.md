# Vibe3D

**Vibe 3D Models: Bring your own tokens.**
Leverages your LLM along with OpenSCAD to build your ideas into a 3D Model.

Describe a part. The model writes OpenSCAD, your browser compiles it, and you get a mesh you can
orbit and export as STL or 3MF. You can also just write the OpenSCAD yourself, or drag the sliders
that the source's own parameters produce — those cost nothing at all.

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

## Reference images

Paste an image into the composer, or pick one with the button beside it — up to four per message.
They carry layout, proportion and intent; **the dimensions still have to come from your words**,
because models read sizes off pixels badly, and the model dropdown marks which models can read an
image at all. An image is sent with the turn you attach it to and with no later turn, so you pay
for it once — across that turn's repair attempts, and never again. The images are not saved — the
conversation is, without them.

## Versions

Every LLM turn, every **Save version** and every successful compile of your own edits is a version
of the document, and nothing is ever deleted: the picker in the menu bar steps to any of them,
`/undo` steps back one, and a change made from an older version simply becomes the next one.
Documents, their versions and their conversations live in this browser's IndexedDB. **Export
project** writes one `.json` you can keep or import anywhere; it never contains the key.

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
