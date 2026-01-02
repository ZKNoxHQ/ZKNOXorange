# ZKNOX Orange

**Ledger Sideloader** - Load custom applications onto Ledger devices for development and testing.

## ⚠️ Development Tool

This tool is intended for **developers** testing their own applications. Only use apps from sources you trust.

## Overview

ZKNOX Orange allows developers to sideload custom applications onto Ledger hardware wallets. It implements the Ledger SCP (Secure Channel Protocol) for secure communication and app deployment.

## Supported Devices

- Ledger Nano S Plus ✅ (recommended for development)
- Ledger Flex ⚠️ (limited Custom CA support)
- Ledger Stax ⚠️ (limited Custom CA support)

## Features

- 📱 **WebHID Support** - Works directly in Chrome/Edge browsers
- 🔐 **SCP v3** - Secure Channel Protocol with encryption and MAC
- 🔑 **Custom CA** - Push custom Certificate Authority for sideloading
- 📦 **App Loading** - Load .hex files with parameters
- 🗑️ **App Management** - List and delete installed apps
- 🧪 **Test CA** - Verify Custom CA installation

## Setup for Sideloading

### 1. Push Custom CA (One-time setup)

1. **Factory reset** your Ledger device
2. Enter **Recovery Mode**:
   - Nano S/S+/X: Hold left button while connecting USB
   - Flex/Stax: Hold button near USB port while connecting
3. Click **Scan USB Devices**
4. Click **Push Custom CA**
5. Complete device onboarding (create PIN)

### 2. Load Applications

1. Connect device (normal mode, unlocked)
2. Click **Connect Device**
3. Load your `.hex` file
4. Optionally load `.map` file for data size
5. Fill in app parameters
6. Click **Load Application**
7. Confirm on device

## Configuration

| Parameter | Description | Example |
|-----------|-------------|---------|
| Target ID | Device identifier | `0x33100004` (Nano S Plus) |
| App Name | Application name | `MyApp` |
| App Version | Version string | `1.0.0` |
| Data Size | NVRAM size from .map | `512` |
| App Flags | Application flags | `0x000` |

### Target IDs

| Device | Target ID |
|--------|-----------|
| Nano S Plus | `0x33100004` |
| Nano X | `0x33000004` |
| Flex | `0x33300004` |
| Stax | `0x33200004` |

## Files

```
zknox-orange/
├── sideloader.html       # Main application
├── dist/
│   └── ledgerjs.bundle.js
├── src/                  # Source modules
│   ├── loadApp.js        # App loading logic
│   ├── deployed.js       # SCP implementation
│   ├── hexLoader.js      # Hex file processing
│   ├── hexParser.js      # Intel HEX parser
│   ├── ecWrapper.js      # Cryptography
│   └── ...
├── zknox-logo.png
├── zknox-orange.jpg
└── README.md
```

## Custom CA Details

ZKNOX Orange uses a deterministic Custom CA:
- **Private Key**: `1` (for simplicity)
- **Public Key**: secp256k1 generator point `G`

```
G = 04 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
       483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
```

## Troubleshooting

### Error: 6511
Device not in Recovery Mode. Reboot while holding button.

### Error: 5707
SCP certificate validation failed. Custom CA may not be installed.

### Error: 6512
Device locked or not in correct state. Unlock and go to dashboard.

### Error: 5214
Custom CA setup rejected. Device may need to be in onboarding state.

### "Broken certificate chain"
Normal when using random SCP key. Custom CA is for app signing, not SCP.

## Command Line Alternative

```bash
# Push Custom CA
python -m ledgerblue.setupCustomCA \
  --targetId 0x33100004 \
  --public 0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8 \
  --name dev

# Load App
python -m ledgerblue.loadApp \
  --targetId 0x33100004 \
  --appName "TestApp" \
  --appVersion "1.0.0" \
  --appFlags 0x000 \
  --dataSize 512 \
  --tlv --delete \
  --fileName app.hex \
  --signApp \
  --signPrivateKey 0000000000000000000000000000000000000000000000000000000000000001 \
  --rootPrivateKey 0000000000000000000000000000000000000000000000000000000000000001
```

## Links

- Website: [zknox.com](https://zknox.com)
- ZKNOX Blue: For official Ledger apps

## License

© 2025 ZKNOX. All rights reserved.
