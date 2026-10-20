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

**Mise à jour (2026-10-20)** : `apps/ecmldsa/` passe aussi au layout `repo`, source ZKNoxHQ/ecml-signer (dépôt rendu public pour que raw.githubusercontent.com serve les fichiers). Son arborescence diffère de ZKNOX-HW-PRIVACY : `build/<target>/bin/app.apdu`, sans niveau `<profile>` ni `artifact-manifest.txt`. L'entrée fixe `binDir: 'build/{target}/bin'` plutôt que d'ajouter un second layout au code ; le contrôle prod/debug ne s'applique pas (manifest absent).

## ADR-005: Firmware update dans Orange (2026-10-14)

**Contexte** : la mise à jour de firmware sans Ledger Live avait été développée dans ZKNOX Blue (ADR-002/003 du dépôt ZKNOXblue). Elle est déplacée ici : Orange est l'outil développeur du site et a déjà le transport Bluetooth et le choix USB/Bluetooth, dont le firmware update a besoin pour les Nano X / Stax / Flex.

**Décision** : `firmwareUpdater.js` et `firmwareUi.js` sont copiés tels quels, avec une seule adaptation, la reconnexion après reboot qui reste sur le lien d'origine (gatt.connect() sur le même `BluetoothDevice`, ou réouverture des HID appairés) avant de demander un geste utilisateur. Le HSM Ledger reste la seule source des blobs : l'hôte relaie des APDU. Jamais de `/update/mcu` avec la version lue sur le device ; la version vient du catalogue `mcu_versions` filtré par `final.mcu_versions` et `from_bootloader_version`.

**Compromis** :
- la réparation bootloader est USB (le chooser de la modale propose USB en premier) ; un Nano X bloqué en bootloader se répare par câble
- testé sur matériel en USB (Nano S+, flux OSU → MCU, via Blue 1.1.x) ; le chemin Bluetooth n'a été validé qu'en boucle fermée
- `transport.js` reçoit la gestion de déconnexion de Blue : les modules partagés entre les deux dépôts (transport, transportBle, hexParser, ledgerWrapper) se synchronisent par copie
