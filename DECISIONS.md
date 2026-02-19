# Decisions architecturales - ZKNOX Orange v2

## ADR-001: Web Crypto API vs AES custom

**Contexte**: L'implémentation v1 portait une implémentation AES complète en JS (~200 lignes: S-Box, key expansion, GF multiplication, MixColumns, ShiftRows). Vérifiée correcte avec test vectors cross-validés Python/JS.

**Décision**: Remplacer par Web Crypto API (`crypto.subtle.encrypt/decrypt` AES-CBC).

**Raison**:
- Élimine une surface d'attaque (code crypto custom)
- Hardware-accelerated dans les navigateurs modernes
- Auditable (API standard W3C)
- -8KB sur le bundle

**Compromis**: Web Crypto est async-only et ajoute toujours PKCS7 padding. Résolu par:
- Encrypt: truncation du dernier bloc PKCS7 (les N premiers bytes CBC sont identiques avec ou sans padding)
- Decrypt: ajout d'un bloc PKCS7 chiffré artificiel, puis truncation

## ADR-002: ECDSA low-S normalization

**Contexte**: Python ecpy utilise des nonces aléatoires, noble/secp256k1 utilise RFC6979. Les deux sont valides, mais certains firmwares Ledger pourraient rejeter high-S.

**Décision**: Double-vérification low-S dans `ecdsaSerialize()`, même si noble v3 normalise déjà.

**Raison**: Défense en profondeur. Le coût est négligeable (une comparaison BigInt).

## ADR-003: noble/secp256k1 v3 API migration

**Contexte**: v3 renomme `ProjectivePoint` → `Point` et `@noble/hashes` change ses exports (`sha256` → `sha2.js`).

**Décision**: Migration directe, pas de shim de compatibilité.

**Raison**: Pas besoin de supporter les deux versions simultanément.
