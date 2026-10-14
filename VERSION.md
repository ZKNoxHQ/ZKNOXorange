# ZKNOX Orange v2.3.0

## Changelog

### v2.3.0 - 2026-10-14 - "Firmware update"

- `src/firmwareUpdater.js` (repris de ZKNOX Blue 1.1.1) : mise à jour de firmware via le scriptrunner Ledger, port de `@ledgerhq/live-common` 34.51 (`socket`, `deviceSDK/tasks/updateFirmware`, `hw/firmwareUpdate-main`, `hw/firmwareUpdate-repair`, `parseGetVersionResponse`, `getLatestFirmwareForDevice`) : OSU → reconnexion → boucle bootloader/MCU (`version = mcu.name` si le bootloader est déjà `from_bootloader_version`, sinon ce bootloader en 3 composantes) → firmware final si l'API en fournit un ; `repair()` pour un device en bootloader (SE rapporté en `-osu` géré)
  - reconnexion après reboot transport-agnostique : en Bluetooth le `BluetoothDevice` est reconnecté par `gatt.connect()` sans chooser, en USB les devices HID déjà appairés sont rouverts ; sinon modale avec boutons USB et Bluetooth
- `src/firmwareUi.js` (repris de ZKNOX Blue 1.2.0) : glu DOM des boutons Check / Update / Bootloader Recovery pilotée par callbacks, consommée par `sideloader.html` (section « 5. Firmware »)
- `src/transport.js` : écoute `navigator.hid` `disconnect` (échec immédiat de l'échange en cours), `sendReport` en échec lève `CommException('Device disconnected')`
- `src/index.js` : exporte `FirmwareUpdater`, `FirmwareError`, `FIRMWARE_DEFAULTS`, `parseGetVersion`, `findBestMCU`, `getFlashMcuOrBootloaderDetails`, `getDeviceModelName`, `FirmwareUi`
- `package.json` : 2.3.0


### v2.2.0 - 2026-10-13 - "Profils prod/dev"

- `src/catalog.js` : layout `repo` suit la nouvelle arborescence de ZKNOX-HW-PRIVACY `build/<profile>/<target>/app.apdu`
  - champ d'entrée `profile` (`prod` par défaut, `dev` = MODE=debug FROST=1), `binDir` par défaut `build/{profile}/{target}`
  - lecture de `artifact-manifest.txt` (mode, frost, commit, elf_sha256) ; un build `debug` est refusé sauf `profile: 'dev'`
  - `parseArtifactManifest` exporté ; `fetchCatalogApp` renvoie `manifest` et `profile`
- `README.md`, `apps/privacy/README.md` : mis à jour
- `package.json` : 2.2.0


### v2.1.0 - 2026-10-12 - "Catalogue distant"

**Catalogue : replay du script `app.apdu` du dépôt firmware**

- `src/apduScript.js` (nouveau) : `parseApduScript`, `describeApduScript`, `replayApduScript(dongle, text, { targetId, rootPrivateKey, delete, onProgress })`
  - rejoue le script hors-ligne du SDK (CLA E0, INS 00) ligne à ligne via `HexLoader.exchange`, donc sous SCP
  - chunks LOAD de 208 octets du SDK = ceux de `HexLoader.load` (238 octets emballés ≤ MTU 0xFE)
  - échec du `deleteApp` initial toléré (app absente)
- `src/catalog.js` (nouveau) : `resolveCatalogFiles`, `fetchCatalogApp`, `TARGET_DIRS`
  - entrée `{ repo, ref }` → `https://raw.githubusercontent.com/<repo>/<ref>/build/<target>/bin/app.apdu`, `<target>` dérivé du `targetId` (nanos2, nanox, stax, flex)
  - entrée `{ dir }` (hex/map/Makefile/manifest) toujours supportée
- `src/device.js` (nouveau) : `getDeviceInfo(dongle)` → `{ targetId, targetName, seVersion, mcuVersion }` via GET_VERSION (E0 01) sur le dashboard ; `fetchCatalogApp(entry, null, dongle)` et `replayApduScript` sans `targetId` l'appellent, une seule carte pour tous les modèles
- `src/transportBle.js` (nouveau) : `TransportWebBLE` (Web Bluetooth) pour Nano X / Stax / Flex, même interface que `TransportWebHID` (`open`, `close`, `exchange`, `exchangeRaw`, `request`)
  - services GATT `13d63400-2c97-{0004,6004,3004}-0000-4c6564676572`, caractéristiques notify / write / writeCmd
  - trames tag 0x05, seq 2 octets BE, longueur sur la première ; MTU négocié par la trame 0x08
  - validé avec un GATT mock (Flex, MTU 156, APDU de 216 octets fragmentée puis réassemblée)
- `src/index.js` : exports des quatre modules
- `apps/privacy/` : `app.hex`, `app.map`, `Makefile`, `manifest.json` supprimés, remplacés par un README ; la source est ZKNoxHQ/ZKNOX-HW-PRIVACY `build/<target>/bin/app.apdu`
- `README.md` : section catalogue (layout `repo`)
- `package.json` : 2.1.0
- Validé hors device : les 5 scripts commités (nanos2, nanox, stax, flex, apex_p) se parsent, `appName=ZKNOX`

### v2.0.0 - 2025-02-18 - "Option Propre"

**Breaking: AES custom remplacé par Web Crypto API**

- `hexLoader.js`: suppression complète de l'implémentation AES custom (~200 lignes)
  - `AES_SBOX`, `AES_RCON`, `aesKeyExpansion`, `aesGfMul`, `aesMixColumn`, `aesEncryptBlock` → supprimés
  - `aesCbcEncryptNoPadding` → réécrit avec `crypto.subtle.encrypt('AES-CBC')` + truncation PKCS7
  - `aesDecryptCBC` → réécrit avec `crypto.subtle.decrypt('AES-CBC')` + padding trick
  - SCP wrap/unwrap utilisent maintenant Web Crypto API async

**Fixes ECDSA**

- `ecWrapper.js`: normalisation low-S explicite dans `ecdsaSerialize()`
  - noble/secp256k1 v3 normalise déjà, mais double-vérification ajoutée
  - Compatibilité avec les devices qui rejettent high-S signatures

**Fixes noble/secp256k1 v3 API**

- `ProjectivePoint` → `Point` (API v3)
- Imports `@noble/hashes` corrigés pour v2.0.1 (`sha2.js`, `hmac.js`, `utils.js`)

**Meilleur error handling SCP**

- `deployed.js`: logging structuré de chaque étape du handshake SCP
  - IDENTIFY → GET_NONCE → VALIDATE_CERT(master) → VALIDATE_CERT(ephemeral) → GET_CERT → COMMIT
  - Erreurs non-9000 loggées avec contexte (expected/unexpected)
  - Error messages incluent SW codes hex

**Build**

- `package.json`: ajout scripts `build`, `watch`, `serve`
- Bundle size: 97KB (vs 106KB v1)

### v1.0.0

- Port initial de ledgerblue Python vers JavaScript
- AES custom, SCP v2/v3, WebHID transport

- 2026-09-16: src/loadApp.js importe @noble/secp256k1 par nom de paquet au lieu de ../node_modules/ (bundle inchangé)
