# ZKNOX Orange v2.0.0

## Changelog

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
