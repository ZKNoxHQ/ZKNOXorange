# ZKNOX Orange

Web-based sideloader for Ledger hardware wallets. Load custom applications onto your device directly from the browser using WebHID.

This repository holds the **engine and the app catalog** (bundled JS + prebuilt
`.hex` binaries). The **UI page lives in the [website repo](https://github.com/ZKNoxHQ/website)**
as `sideloader.html`, so it shares the site's `styles.css` and `nav.js`. This repo
is cloned into the website as `zknox-orange/`, and the page fetches everything
from there.

## Quick Start

```bash
npm install
npm run build
```

Then serve it from the website checkout (this repo must be cloned inside it as
`zknox-orange/`, see the website README):

```bash
cd /path/to/website
python3 -m http.server 8080     # http://localhost:8080/sideloader.html
```

Chrome/Edge 89+ required (WebHID). The page must be served over HTTP — `file://`
breaks both the module import and the root-relative `/nav.js`.

## Project Structure

```
├── src/                     # Source modules
│   ├── catalog.js           # Catalog artifact resolution (local dir or GitHub raw)
│   ├── apduScript.js        # Offline load script (app.apdu) parser + SCP replay
│   ├── device.js            # getDeviceInfo: targetId / SE version from the dashboard
│   ├── transportBle.js      # Web Bluetooth transport (Nano X, Stax, Flex)
│   ├── index.js             # Entry point & exports
│   ├── deployed.js          # SCP handshake (Secure Channel Protocol)
│   ├── ecWrapper.js         # ECDSA / secp256k1 wrapper
│   ├── hexLoader.js         # Intel HEX parser + app install APDUs
│   └── commException.js     # Transport error handling
├── dist/
│   └── ledgerjs.bundle.js   # Built bundle (esbuild)
├── apps/                    # ZKNOX Apps Catalog
│   ├── privacy/
│   │   └── README.md        # app.apdu replayed from ZKNoxHQ/ZKNOX-HW-PRIVACY (layout `repo`)
│   ├── ecmldsa/
│   │   └── README.md        # app.apdu replayed from ZKNoxHQ/ecml-signer (layout `repo`, `binDir`)
│   └── unchained/           # Local layout (`dir`)
│       ├── app.hex          # Compiled application binary
│       ├── app.map          # Linker map (dataSize, installParamsSize)
│       ├── Makefile         # Build config (APPNAME, curves, paths)
│       └── manifest.json    # SDK metadata (api_level)
└── package.json
```

## Bluetooth

`TransportWebBLE.request()` opens the browser's Bluetooth chooser filtered on
the Ledger GATT services (Nano X, Stax, Flex) and returns a transport with the
same interface as `TransportWebHID`, so `loadApp`, `replayApduScript` and
`getDeviceInfo` take either. Web Bluetooth needs Chrome or Edge and a secure
context (https or localhost); the device must be on the dashboard with
Bluetooth enabled, and the first connection pairs it (confirm on the device).

```javascript
const transport = await TransportWebBLE.request();
```

## Firmware update

Section "5. Firmware" of `sideloader.html`. **Check Firmware** asks Ledger's manager API for the
next OS version and whether the MCU must be flashed; **Update Firmware** runs the same sequence as
Ledger Live through Ledger's HSM (OSU, optional bootloader/MCU flashes, final firmware), over USB or
Bluetooth. After each reboot the page reopens the device on the same link, or asks you to click
**Reconnect** (WebHID / Web Bluetooth need a user gesture). **Bootloader Recovery** repairs a device
stuck on "Bootloader" (plug it over USB holding the left button). Engine: `src/firmwareUpdater.js`
(port of `@ledgerhq/live-common` `updateFirmwareTask` / `firmwareUpdate-repair`), UI glue:
`src/firmwareUi.js`.

## ZKNOX Apps Catalog

The catalog lets users install pre-built apps in one click. Clicking a card fetches all files, auto-detects parameters, and sideloads directly.

### What gets auto-detected

| Parameter | Source | File |
|---|---|---|
| `APPNAME` | Makefile | `apps/{id}/Makefile` |
| `APPVERSION` (M.N.P) | Makefile | `apps/{id}/Makefile` |
| `CURVE_APP_LOAD_PARAMS` | Makefile | `apps/{id}/Makefile` |
| `PATH_APP_LOAD_PARAMS` | Makefile | `apps/{id}/Makefile` |
| `dataSize` | Map file | `apps/{id}/app.map` |
| `installParamsSize` | Map file | `apps/{id}/app.map` |
| `api_level` | Manifest | `apps/{id}/manifest.json` |

### Adding an app to the catalog

Two layouts. Prefer `repo`: the build output stays in the firmware repository,
one entry covers every device, and `ref` identifies the exact build served.

#### Layout `repo` (offline load script replayed from the firmware repository)

The Ledger SDK writes an offline load script, `app.apdu`, on every build: the
exact loader conversation `make load` would have, one plaintext APDU per line,
with targetId, `api_level`, section sizes and flags already baked in. The
firmware repository commits it as `build/<profile>/<target>/app.apdu`
(`prod`: MODE=prod FROST=0; `dev`: MODE=debug FROST=1) beside an
`artifact-manifest.txt`; the sideloader fetches it and replays it over its
own SCP channel (`replayApduScript`). No rebuild, no hex/map/Makefile parsing.

Register the entry in `sideloader.html`:

```javascript
const catalogApps = [
    // ... existing apps ...
    { id: 'privacy', name: 'ZKNOX Privacy', icon: '🛡️', desc: 'EdDSA-Poseidon + FROST',
      repo: 'ZKNoxHQ/ZKNOX-HW-PRIVACY', ref: 'e3fd460bdaaa8f3b87c1f111b9eb9b94de88eabb', profile: 'prod' },
    // ecml-signer commits build/<target>/bin/app.apdu: no profile level, no manifest
    { id: 'ecmldsa', name: 'EC/ML-DSA', icon: '🔮', desc: 'Hybrid signatures',
      repo: 'ZKNoxHQ/ecml-signer', ref: 'a6e4ab665193b21933e289ac164fe9269d9fb22f', binDir: 'build/{target}/bin' },
];
```

Install:

```javascript
import { fetchCatalogApp, replayApduScript } from './zknox-orange/dist/ledgerjs.bundle.js';
const { targetId, apdu, info } = await fetchCatalogApp(entry, null, dongle); // targetId read from the device
await replayApduScript(dongle, apdu, { targetId, onProgress: ({ index, total }) => { /* progress bar */ } });
```

`fetchCatalogApp` reads the `targetId` from the device (`getDeviceInfo`:
GET_VERSION on the dashboard, so the user must not be inside an app) and
resolves `<target>` from it (`nanos2`, `nanox`, `stax`, `flex`). One card
serves every model; no per-device button. `appFlags`, curves and paths are not
read from the catalog entry for this layout: they are in the script.

Fields:

- `repo` — `owner/name` on GitHub
- `ref` — branch, tag or commit SHA; pin a SHA for anything served to users
- `profile` — `prod` (default) or `dev`; a `dev` build is refused unless the entry says so
- `binDir` — optional, default `build/{profile}/{target}`; set it for a
  repository with another layout (ecml-signer: `build/{target}/bin`)

`fetchCatalogApp` also returns the parsed `artifact-manifest.txt` (`mode`,
`frost`, `commit`, `elf_sha256`) when the repository ships one. Without it
(ecml-signer) `manifest` is `null` and no prod/debug check is made.

#### Layout `dir` (artifacts committed next to the sideloader)

##### 1. Create the app directory

```
apps/myapp/
├── app.hex
├── app.map
├── Makefile
└── manifest.json
```

Copy `app.hex` and `app.map` from your build output. Copy the `Makefile` from your app source.

##### 2. Create `manifest.json`

```json
{
    "api_level": 25,
    "_comment": "api_level comes from the SDK, not the app Makefile. To find it: grep -r 'API_LEVEL' $BOLOS_SDK/ --include='Makefile*' | head"
}
```

The `api_level` is set by the Ledger SDK used at compile time, not by the app itself. To find the value for your build environment:

```bash
grep -r "API_LEVEL" $BOLOS_SDK/ --include="Makefile*" | head
```

All apps compiled with the same SDK share the same `api_level`.

##### 3. Register in the website's `sideloader.html`

```javascript
const catalogApps = [
    // ... existing apps ...
    { id: 'myapp', name: 'My App', icon: '🔧', desc: 'Short description', dir: 'zknox-orange/apps/myapp', appFlags: 0 },
];
```

Common fields:

- `id` — unique identifier
- `name` — display name on the card
- `icon` — emoji shown on the card
- `desc` — short description shown below the name
- `dir` — path to the app directory, relative to the website root (`zknox-orange/apps/{id}`)
- `appFlags` — app flags value (typically `0`, see SDK `include/appflags.h`)
- `frontUrl` — optional link to the app's companion web front-end

#### Makefile requirements

The parser reads these variables from the Makefile:

```makefile
APPNAME = "MyApp"
APPVERSION_M = 1
APPVERSION_N = 0
APPVERSION_P = 0
CURVE_APP_LOAD_PARAMS = secp256k1 ed25519
PATH_APP_LOAD_PARAMS = "44'/60'"
```

Lines containing Make expressions (`$(...)`) are ignored — only simple assignments are parsed.

### Updating an app

Layout `repo`: bump `ref`. Layout `dir`: replace `app.hex` and `app.map` with the new build artifacts. If the SDK version changed, update `api_level` in `manifest.json`. The Makefile is re-parsed on every install, so changes to curves, paths, or version take effect immediately.

## Usage

### Normal Mode (sideloading)

1. Put device in **Dashboard mode** (main menu, no app open)
2. Select device type
3. Click **Connect Device**
4. Click an app from the **ZKNOX Apps Catalog** — install is automatic
5. Or fill in **Application Details** manually and click **Load Application**

### Custom CA Setup (first time)

Before sideloading, a Custom CA must be installed on the device:

1. Enter **Recovery Mode** (hold button while connecting USB)
2. Click **Scan USB Devices**
3. Click **Push Custom CA**
4. Reboot device to normal Dashboard mode

## Build

```bash
npm run build    # one-shot bundle
npm run watch    # rebuild on changes
```

The bundle is built with esbuild from `src/index.js` to `dist/ledgerjs.bundle.js`.

## Dependencies

- `@noble/secp256k1` v3 — ECDSA signatures (RFC6979)
- `@noble/hashes` v2 — SHA-256, HMAC
- `esbuild` — bundler
