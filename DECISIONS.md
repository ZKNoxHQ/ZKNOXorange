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

## ADR-004: Catalogue : replay du script hors-ligne `app.apdu` du dépôt firmware

**Contexte**: `apps/privacy/` contenait une copie manuelle d'un seul `app.hex` (Nano S+) de ZKNOX-HW-PRIVACY, sans lien vers le commit firmware. ZKNOX-HW-PRIVACY commite `build/<target>/bin/{app.apdu,app.elf}` pour cinq cibles, pas de hex ni de map, et on ne veut pas rebuild.

**Décision**: Le catalogue référence le dépôt firmware (`repo` + `ref`) ; le sideloader récupère `build/<target>/bin/app.apdu` sur raw.githubusercontent.com et le rejoue tel quel sous son propre canal SCP (`replayApduScript`), `<target>` dérivé du `targetId` du device.

**Raison**:
- zéro rebuild, zéro parsing : targetId, api_level, tailles de sections, flags et chunks sont ceux que le SDK a figés au build
- une seule source de vérité, un `ref` épinglable (SHA) qui identifie exactement le binaire servi
- multi-device sans dupliquer de binaires ici
- le script hors-ligne est en clair (pas de SCP) : `HexLoader.exchange` l'emballe exactement comme ledgerblue l'aurait fait en ligne

**Alternatives écartées**:
- parser `app.elf` en JS pour reconstituer hex + tailles : un parseur ELF de plus dans le bundle pour retrouver ce que le script contient déjà
- exiger hex/map/manifest côté firmware : impose un rebuild et une convention de plus

**Compromis**:
- le script ne dit pas s'il vient d'un build `prod` ou `debug` ; seule la discipline de commit côté firmware le garantit
- `appFlags` du catalogue ignoré pour ce layout (figé dans le createApp du script)
- dépendance à raw.githubusercontent.com (CORS `*`, pas de SLA) ; le layout `dir` reste pour un miroir local
- `ref: 'main'` n'est pas reproductible ; développement seulement
