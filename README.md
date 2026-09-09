# ZKNOX Orange

Web-based sideloader for Ledger hardware wallets. Load custom applications onto your device directly from the browser using WebHID.

## Quick Start

```bash
npm install
npm run build
npm run serve        # http://localhost:8080
```

Open `sideloader.html` in Chrome/Edge 89+ (WebHID required).

## Project Structure

```
├── sideloader.html          # Main UI
├── src/                     # Source modules
│   ├── index.js             # Entry point & exports
│   ├── deployed.js          # SCP handshake (Secure Channel Protocol)
│   ├── ecWrapper.js         # ECDSA / secp256k1 wrapper
│   ├── hexLoader.js         # Intel HEX parser + app install APDUs
│   └── commException.js     # Transport error handling
├── dist/
│   └── ledgerjs.bundle.js   # Built bundle (esbuild)
├── apps/                    # ZKNOX Apps Catalog
│   ├── privacy/
│   │   ├── app.hex          # Compiled application binary
│   │   ├── app.map          # Linker map (dataSize, installParamsSize)
│   │   ├── Makefile         # Build config (APPNAME, curves, paths)
│   │   └── manifest.json    # SDK metadata (api_level)
│   └── ecmldsa/
│       ├── app.hex
│       ├── app.map
│       ├── Makefile
│       └── manifest.json
└── package.json
```

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

#### 1. Create the app directory

```
apps/myapp/
├── app.hex
├── app.map
├── Makefile
└── manifest.json
```

Copy `app.hex` and `app.map` from your build output. Copy the `Makefile` from your app source.

#### 2. Create `manifest.json`

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

#### 3. Register in `sideloader.html`

Find the `catalogApps` array in the `<script>` section and add an entry:

```javascript
const catalogApps = [
    // ... existing apps ...
    { id: 'myapp', name: 'My App', icon: '🔧', desc: 'Short description', dir: 'apps/myapp', appFlags: 0 },
];
```

Fields:

- `id` — unique identifier, must match the directory name under `apps/`
- `name` — display name on the card
- `icon` — emoji shown on the card
- `desc` — short description shown below the name
- `dir` — path to the app directory (always `apps/{id}`)
- `appFlags` — app flags value (typically `0`, see SDK `include/appflags.h`)

#### 4. Makefile requirements

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

Replace `app.hex` and `app.map` with the new build artifacts. If the SDK version changed, update `api_level` in `manifest.json`. The Makefile is re-parsed on every install, so changes to curves, paths, or version take effect immediately.

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
