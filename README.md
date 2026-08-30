# ai-modeller

A browser-only 3D modelling tool. Describe a part, an LLM writes OpenSCAD, the browser compiles
it, and you export STL or 3MF. You can also just write the OpenSCAD yourself, or drag the sliders
the source's own parameters produce. There is no backend.

Design: [docs/design.md](docs/design.md) · Plans: [docs/superpowers/plans](docs/superpowers/plans)

## Your API key

The model runs on [OpenRouter](https://openrouter.ai), with your key. Two ways to provide it:

- **Connect OpenRouter** runs an OAuth PKCE flow and mints a key scoped to this app, which you
  can revoke without touching the rest of your account.
- **Paste a key** works too, including keys for other OpenAI-compatible hosts — change the base
  URL and the model id and nothing else needs to change.

The key is stored in this browser's `localStorage` under `aimodeller.key`, on its own, and it is
sent to exactly one place: the model host you configured. Revoke it any time at
<https://openrouter.ai/settings/keys>; the settings panel links to the specific key. **This app
cannot set a spend cap** — that is a manual step in your OpenRouter settings.

Any script running on the page could read the key; that is inherent to browser storage, not a
choice this app made. The mitigation is a strict Content-Security-Policy whose `connect-src`
allows only OpenRouter, plus keeping the dependency list short.

One honest note about **Stop**: aborting the request stops billing on OpenAI, Anthropic, DeepSeek
and xAI, but not on Google, Groq or Mistral, which bill the whole completion once it starts.

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
