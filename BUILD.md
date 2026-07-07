# Building & packaging unb8

unb8 is plain JavaScript — there is **no build step** for development. You only
need tooling to produce a distributable package.

The single `unb8/` folder runs in both browsers: Chrome uses
`background.service_worker`, Firefox 121+ uses `background.scripts`. HTML parsing
runs in a Chrome offscreen document (`offscreen.js`) or inline on Firefox's event
page — both call the shared `parser.js`, selected by a `DOMParser` feature-detect
in `background.js`.

## Run it for development (no packaging)

**Chrome / Chromium / Edge**
1. `chrome://extensions/` → enable **Developer mode**
2. **Load unpacked** → select the `unb8/` folder
3. After editing `background.js` / `parser.js` / `offscreen.js`: click **reload**
   on the extension card. After editing `content.js`: reload the card **and** the
   news-site tab.

**Firefox** (temporary — removed when Firefox restarts)
1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**
2. Select `unb8/manifest.json`

## Package a distributable .xpi (Firefox)

Firefox requires add-ons to be **Mozilla-signed**, even for self-distribution.
Packaging uses [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
(needs [Node.js](https://nodejs.org/)); it is only for packaging, not for dev.

**Unsigned build** — loads only as a temporary add-on, or permanently in Firefox
Developer Edition / Nightly with `xpinstall.signatures.required` set to `false`:
```
npx web-ext build --source-dir=unb8 --overwrite-dest
```
→ a package in `web-ext-artifacts/` (rename `.zip` → `.xpi` to load it directly,
or just point *Load Temporary Add-on* at `unb8/manifest.json`).

**Signed build** — installs permanently in any Firefox:
```
npx web-ext sign --channel=unlisted --source-dir=unb8 \
  --api-key=<AMO issuer> --api-secret=<AMO secret>
```
→ a Mozilla-signed `.xpi` in `web-ext-artifacts/`. Get the API key + secret at
[addons.mozilla.org](https://addons.mozilla.org/) → Developer Hub →
**Manage API Keys** (a free Mozilla account is required). `--channel=unlisted`
keeps the add-on out of Mozilla's public gallery, so you distribute the file
yourself (e.g. a GitHub Release).

> The Chrome-only `offscreen` permission and `service_worker` key surface as
> `addons-linter` **warnings**, not errors — unlisted signing proceeds on warnings.

## Cutting a release

1. Bump `"version"` in `unb8/manifest.json` (Mozilla refuses to re-sign a version
   that already exists).
2. Sign (command above).
3. Publish the signed `.xpi` — e.g. attach it to a GitHub Release.

## Chrome packaging

Chrome loads `unb8/` unpacked as-is. For the Chrome Web Store, zip the **contents**
of `unb8/` (so `manifest.json` is at the archive root) and upload via the
Developer Dashboard.
