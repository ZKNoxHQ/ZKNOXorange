/**
 * Hex Loader - Core app loading functionality with SCP encryption
 * Port of ledgerblue/hexLoader.py
 * 
 * Handles secure APDU encryption and app loading commands
 */

import { sha256 } from '@noble/hashes/sha256';
import { PrivateKey } from './ecWrapper.js';

// Constants
const LOAD_SEGMENT_CHUNK_HEADER_LENGTH = 3;
const MIN_PADDING_LENGTH = 1;
const SCP_MAC_LENGTH = 14;

// TLV Tags
export const BOLOS_TAG_APPNAME = 0x01;
export const BOLOS_TAG_APPVERSION = 0x02;
export const BOLOS_TAG_ICON = 0x03;
export const BOLOS_TAG_DERIVEPATH = 0x04;
export const BOLOS_TAG_DATASIZE = 0x05;
export const BOLOS_TAG_DEPENDENCY = 0x06;

// CRC16-CCITT table
const TABLE_CRC16_CCITT = [
    0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
    0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
    0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
    0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
    0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
    0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
    0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
    0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
    0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
    0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
    0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
    0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
    0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
    0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
    0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
    0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
    0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
    0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
    0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
    0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
    0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
    0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
    0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
    0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
    0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
    0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
    0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
    0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
    0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
    0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
    0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
    0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0
];

/**
 * Encode length-value
 * @param {Uint8Array} v - Value
 * @returns {Uint8Array}
 */
export function encodelv(v) {
    const L = v.length;
    let header;
    
    if (L < 128) {
        header = new Uint8Array([L]);
    } else if (L < 256) {
        header = new Uint8Array([0x81, L]);
    } else if (L < 65536) {
        header = new Uint8Array([0x82, (L >> 8) & 0xff, L & 0xff]);
    } else {
        throw new Error('Unimplemented LV encoding');
    }
    
    const result = new Uint8Array(header.length + v.length);
    result.set(header);
    result.set(v, header.length);
    return result;
}

/**
 * Encode tag-length-value
 * @param {number} t - Tag
 * @param {Uint8Array} v - Value
 * @returns {Uint8Array}
 */
export function encodetlv(t, v) {
    const L = v.length;
    let header;
    
    if (L < 128) {
        header = new Uint8Array([t, L]);
    } else if (L < 256) {
        header = new Uint8Array([t, 0x81, L]);
    } else if (L < 65536) {
        header = new Uint8Array([t, 0x82, (L >> 8) & 0xff, L & 0xff]);
    } else {
        throw new Error('Unimplemented TLV encoding');
    }
    
    const result = new Uint8Array(header.length + v.length);
    result.set(header);
    result.set(v, header.length);
    return result;
}

/**
 * HexLoader class - manages app loading with SCP encryption
 */
export class HexLoader {
    /**
     * @param {object} card - Transport object with exchange() method
     * @param {number} cla - Command class byte (default 0xE0)
     * @param {boolean} secure - Enable SCP encryption
     * @param {object|Uint8Array} mutauthResult - Result from getDeployedSecretV2
     * @param {boolean} relative - Use relative addressing
     * @param {number|null} cleardataBlockLen - Block length for clear data
     * @param {boolean} scpv3 - Use SCP v3 format
     */
    constructor(card, cla = 0xe0, secure = false, mutauthResult = null, relative = true, cleardataBlockLen = null, scpv3 = false) {
        this.card = card;
        this.cla = cla;
        this.secure = secure;
        this.createappParams = null;
        this.createpackParams = null;
        this.scpv3 = scpv3;
        
        // Max MTU
        this.maxMtu = 0xfe;
        if (this.card !== null && this.card.apduMaxDataSize) {
            this.maxMtu = Math.min(this.maxMtu, this.card.apduMaxDataSize());
        }
        
        this.scpVersion = 2;
        this.key = mutauthResult;
        this.iv = new Uint8Array(16); // All zeros
        this.relative = relative;
        
        this.cleardataBlockLen = cleardataBlockLen;
        if (this.cleardataBlockLen !== null && this.card !== null && this.card.apduMaxDataSize) {
            this.cleardataBlockLen = Math.min(this.cleardataBlockLen, this.card.apduMaxDataSize());
        }
        
        if (scpv3) {
            this.scpEncKey = this._scpDeriveKey(mutauthResult, 0);
            this.scpVersion = 3;
            if (this.card !== null && this.card.apduMaxDataSize) {
                this.maxMtu = Math.min(0xfe, this.card.apduMaxDataSize() & 0xf0);
            }
            return;
        }
        
        // SCP V3 with object result from getDeployedSecretV2 (Nano S Plus and newer)
        // When passing a dict (not scpv3=True), Python uses SHA256 + EC point key derivation:
        // di = sha256(keyIndex || retry || ecdh_secret)
        // Pi = di * G
        // ki = sha256(Pi)[0:16]
        if (mutauthResult && typeof mutauthResult === 'object' && mutauthResult.ecdh_secret) {
            console.log('HexLoader: Got ecdh_secret object, using SCP v3 (with MAC)');
            const ecdhSecret = mutauthResult.ecdh_secret;
            console.log('HexLoader: ECDH secret:', bytesToHex(ecdhSecret));
            
            // SCP v3 key derivation using SHA256 + EC point method
            // ENC key: keyIndex=0
            this.scpEncKey = this._scpDeriveKeyV3(ecdhSecret, 0).slice(0, 16);
            console.log('HexLoader: SCP v3 ENC key:', bytesToHex(this.scpEncKey));
            
            // MAC key: keyIndex=1
            this.scpMacKey = this._scpDeriveKeyV3(ecdhSecret, 1).slice(0, 16);
            console.log('HexLoader: SCP v3 MAC key:', bytesToHex(this.scpMacKey));
            
            // Initialize IVs to zero
            this.scpEncIv = new Uint8Array(16);
            this.scpMacIv = new Uint8Array(16);
            
            this.scpVersion = 3;
        }
    }
    
    /**
     * SCP v3 key derivation using SHA256 + EC point method
     * di = sha256(keyIndex || retry || ecdhSecret)
     * Pi = di * G
     * ki = sha256(Pi)
     * @param {Uint8Array} ecdhSecret 
     * @param {number} keyIndex 
     * @returns {Uint8Array} 32-byte key
     */
    _scpDeriveKeyV3(ecdhSecret, keyIndex) {
        const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        let retry = 0;
        
        while (true) {
            // di = sha256(keyIndex || retry || ecdhSecret)
            const data = new Uint8Array(5 + ecdhSecret.length);
            // Big-endian key index (4 bytes)
            data[0] = (keyIndex >> 24) & 0xff;
            data[1] = (keyIndex >> 16) & 0xff;
            data[2] = (keyIndex >> 8) & 0xff;
            data[3] = keyIndex & 0xff;
            // Retry counter (1 byte)
            data[4] = retry;
            // ECDH secret
            data.set(ecdhSecret, 5);
            
            const di = sha256(data);
            
            // Check if di < curve order
            const diBigInt = bytesToBigInt(di);
            if (diBigInt < SECP256K1_ORDER) {
                // Pi = di * G (point multiplication)
                const privkey = new PrivateKey(di);
                const Pi = privkey.pubkey.serialize(false);  // Uncompressed
                // ki = sha256(Pi)
                const ki = sha256(Pi);
                console.log('HexLoader: Key derivation (keyIndex=' + keyIndex + '): ki=' + bytesToHex(ki));
                return ki;
            }
            
            retry++;
            if (retry > 100) {
                throw new Error('Key derivation failed after 100 retries');
            }
        }
    }

    /**
     * Calculate CRC16-CCITT
     * @param {Uint8Array} data 
     * @returns {number}
     */
    crc16(data) {
        let crc = 0xffff;
        for (let i = 0; i < data.length; i++) {
            const b = (data[i] ^ ((crc >> 8) & 0xff)) & 0xff;
            crc = (TABLE_CRC16_CCITT[b] ^ (crc << 8)) & 0xffff;
        }
        return crc;
    }

    /**
     * Exchange APDU with optional SCP encryption
     * @param {number} cla 
     * @param {number} ins 
     * @param {number} p1 
     * @param {number} p2 
     * @param {Uint8Array} data 
     * @returns {Promise<Uint8Array>}
     */
    async exchange(cla, ins, p1, p2, data) {
        // Python's exchange() simply wraps the data and sends it
        // The command byte (0x0C for delete, 0x0B for create, etc.) is INSIDE the data
        // INS is always 0x00 for encrypted commands
        
        // Wrap data with SCP encryption
        const wrappedData = await this.scpWrap(data);
        
        // Build APDU
        const apdu = new Uint8Array(5 + wrappedData.length);
        apdu[0] = cla;
        apdu[1] = ins;
        apdu[2] = p1;
        apdu[3] = p2;
        apdu[4] = wrappedData.length;
        apdu.set(wrappedData, 5);
        
        if (this.card === null) {
            console.log(bytesToHex(apdu));
            return new Uint8Array(0);
        }
        
        // Exchange and unwrap response
        const response = await this.card.exchange(apdu);
        return this.scpUnwrap(response);
    }

    /**
     * Wrap data with SCP encryption
     * @param {Uint8Array} data 
     * @returns {Promise<Uint8Array>}
     */
    async scpWrap(data) {
        if (!this.secure || data === null || data.length === 0) {
            return data;
        }
        
        console.log('scpWrap input:', bytesToHex(data));
        console.log('scpWrap scpVersion:', this.scpVersion);
        
        if (this.scpVersion === 3) {
            // Pad with 0x80 + zeros to 16-byte boundary
            let paddedLen = data.length + 1;
            while ((paddedLen % 16) !== 0) {
                paddedLen++;
            }
            const paddedData = new Uint8Array(paddedLen);
            paddedData.set(data);
            paddedData[data.length] = 0x80;
            
            console.log('scpWrap SCP v3 padded:', bytesToHex(paddedData));
            console.log('scpWrap encKey:', bytesToHex(this.scpEncKey));
            console.log('scpWrap encIv:', bytesToHex(this.scpEncIv));
            
            // AES-CBC encrypt (using pure JS implementation to avoid padding issues)
            const encryptedData = aesCbcEncryptNoPadding(this.scpEncKey, this.scpEncIv, paddedData);
            console.log('scpWrap encrypted:', bytesToHex(encryptedData));
            
            // Update IV for next encryption (last 16 bytes of ciphertext)
            this.scpEncIv = encryptedData.slice(-16);
            
            // MAC calculation: AES-CBC-MAC over the encrypted data
            console.log('scpWrap macKey:', bytesToHex(this.scpMacKey));
            console.log('scpWrap macIv:', bytesToHex(this.scpMacIv));
            const macData = aesCbcEncryptNoPadding(this.scpMacKey, this.scpMacIv, encryptedData);
            this.scpMacIv = macData.slice(-16);  // Last block becomes new MAC IV
            console.log('scpWrap mac result:', bytesToHex(this.scpMacIv));
            
            // Append LAST 14 bytes of MAC (Python uses [-SCP_MAC_LENGTH:])
            const result = new Uint8Array(encryptedData.length + SCP_MAC_LENGTH);
            result.set(encryptedData);
            result.set(this.scpMacIv.slice(-SCP_MAC_LENGTH), encryptedData.length);  // LAST 14 bytes!
            
            console.log('scpWrap final result:', bytesToHex(result));
            return result;
        } else {
            // SCP v2 (no MAC)
            console.log('scpWrap SCP v2 (no MAC)');
            console.log('scpWrap input:', bytesToHex(data));
            
            let paddedLen = data.length + 1;
            while ((paddedLen % 16) !== 0) {
                paddedLen++;
            }
            const paddedData = new Uint8Array(paddedLen);
            paddedData.set(data);
            paddedData[data.length] = 0x80;
            
            console.log('scpWrap padded:', bytesToHex(paddedData));
            console.log('scpWrap key:', bytesToHex(this.key));
            console.log('scpWrap iv:', bytesToHex(this.iv));
            
            const encryptedData = await aesEncryptCBC(this.key, this.iv, paddedData);
            this.iv = encryptedData.slice(-16);
            
            console.log('scpWrap encrypted:', bytesToHex(encryptedData));
            return encryptedData;
        }
    }

    /**
     * Unwrap response with SCP decryption
     * @param {Uint8Array} data 
     * @returns {Promise<Uint8Array>}
     */
    async scpUnwrap(data) {
        if (!this.secure || data === null || data.length === 0 || data.length === 2) {
            return data;
        }
        
        const PADDING_CHAR = 0x80;
        
        if (this.scpVersion === 3) {
            // Verify MAC
            const encryptedData = data.slice(0, -SCP_MAC_LENGTH);
            const receivedMac = data.slice(-SCP_MAC_LENGTH);
            
            const macData = aesCbcEncryptNoPadding(this.scpMacKey, this.scpMacIv, encryptedData);
            this.scpMacIv = macData.slice(-16);
            
            // Compare LAST 14 bytes of MAC result (Python: self.scp_mac_iv[-SCP_MAC_LENGTH:])
            const expectedMac = this.scpMacIv.slice(-SCP_MAC_LENGTH);
            if (!arraysEqual(expectedMac, receivedMac)) {
                throw new Error('Invalid SCP MAC');
            }
            
            // Decrypt
            const decryptedData = await aesDecryptCBC(this.scpEncKey, this.scpEncIv, encryptedData);
            this.scpEncIv = encryptedData.slice(-16);
            
            // Remove padding
            let L = decryptedData.length - 1;
            while (decryptedData[L] !== PADDING_CHAR) {
                L--;
                if (L === -1) {
                    throw new Error('Invalid SCP ENC padding');
                }
            }
            
            return decryptedData.slice(0, L);
        } else {
            // SCP v2 (legacy)
            const decryptedData = await aesDecryptCBC(this.key, this.iv, data);
            
            let L = decryptedData.length - 1;
            while (decryptedData[L] !== PADDING_CHAR) {
                L--;
                if (L === -1) {
                    throw new Error('Invalid SCP ENC padding');
                }
            }
            
            this.iv = data.slice(-16);
            return decryptedData.slice(0, L);
        }
    }

    /**
     * Select memory segment
     * @param {number} baseAddress 
     */
    async selectSegment(baseAddress) {
        const data = new Uint8Array(5);
        data[0] = 0x05;
        data[1] = (baseAddress >> 24) & 0xff;
        data[2] = (baseAddress >> 16) & 0xff;
        data[3] = (baseAddress >> 8) & 0xff;
        data[4] = baseAddress & 0xff;
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Load a chunk of segment data
     * @param {number} offset 
     * @param {Uint8Array} chunk 
     */
    async loadSegmentChunk(offset, chunk) {
        const data = new Uint8Array(3 + chunk.length);
        data[0] = 0x06;
        data[1] = (offset >> 8) & 0xff;
        data[2] = offset & 0xff;
        data.set(chunk, 3);
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Flush current segment
     */
    async flushSegment() {
        await this.exchange(this.cla, 0x00, 0x00, 0x00, new Uint8Array([0x07]));
    }

    /**
     * Verify CRC of segment
     * @param {number} offsetSegment 
     * @param {number} lengthSegment 
     * @param {number} crcExpected 
     */
    async crcSegment(offsetSegment, lengthSegment, crcExpected) {
        const data = new Uint8Array(9);
        data[0] = 0x08;
        data[1] = (offsetSegment >> 8) & 0xff;
        data[2] = offsetSegment & 0xff;
        data[3] = (lengthSegment >> 24) & 0xff;
        data[4] = (lengthSegment >> 16) & 0xff;
        data[5] = (lengthSegment >> 8) & 0xff;
        data[6] = lengthSegment & 0xff;
        data[7] = (crcExpected >> 8) & 0xff;
        data[8] = crcExpected & 0xff;
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Validate target ID
     * @param {number} targetId 
     */
    async validateTargetId(targetId) {
        const data = new Uint8Array(4);
        data[0] = (targetId >> 24) & 0xff;
        data[1] = (targetId >> 16) & 0xff;
        data[2] = (targetId >> 8) & 0xff;
        data[3] = targetId & 0xff;
        await this.exchange(this.cla, 0x04, 0x00, 0x00, data);
    }

    /**
     * Boot the application
     * @param {number} bootAddr 
     * @param {Uint8Array|null} signature 
     */
    async boot(bootAddr, signature = null) {
        bootAddr |= 1; // Force Thumb mode
        let data;
        if (signature !== null) {
            data = new Uint8Array(6 + signature.length);
            data[0] = 0x09;
            data[1] = (bootAddr >> 24) & 0xff;
            data[2] = (bootAddr >> 16) & 0xff;
            data[3] = (bootAddr >> 8) & 0xff;
            data[4] = bootAddr & 0xff;
            data[5] = signature.length;
            data.set(signature, 6);
        } else {
            data = new Uint8Array(5);
            data[0] = 0x09;
            data[1] = (bootAddr >> 24) & 0xff;
            data[2] = (bootAddr >> 16) & 0xff;
            data[3] = (bootAddr >> 8) & 0xff;
            data[4] = bootAddr & 0xff;
        }
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Commit the application (TLV mode)
     * @param {Uint8Array|null} signature 
     */
    async commit(signature = null) {
        let data;
        if (signature !== null) {
            data = new Uint8Array(2 + signature.length);
            data[0] = 0x09;
            data[1] = signature.length;
            data.set(signature, 2);
        } else {
            data = new Uint8Array([0x09]);
        }
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Create app with install parameters (legacy mode)
     */
    async createAppNoInstallParams(appFlags, appLength, appName, icon = null, path = null, iconOffset = null, iconSize = null, appVersion = null) {
        // Build data: 0x0b || appLength(4) || appFlags(4) || appNameLen(1) || appName
        let dataLen = 1 + 4 + 4 + 1 + appName.length;
        
        if (iconOffset === null) {
            if (icon !== null) {
                dataLen += 1 + icon.length;
            } else {
                dataLen += 1;
            }
        }
        
        if (path !== null) {
            dataLen += 1 + path.length;
        } else {
            dataLen += 1;
        }
        
        if (iconOffset !== null) {
            dataLen += 4 + 2;
        }
        
        if (appVersion !== null) {
            dataLen += 1 + appVersion.length;
        }
        
        const data = new Uint8Array(dataLen);
        let offset = 0;
        
        data[offset++] = 0x0b;
        
        // App length (4 bytes)
        data[offset++] = (appLength >> 24) & 0xff;
        data[offset++] = (appLength >> 16) & 0xff;
        data[offset++] = (appLength >> 8) & 0xff;
        data[offset++] = appLength & 0xff;
        
        // App flags (4 bytes)
        data[offset++] = (appFlags >> 24) & 0xff;
        data[offset++] = (appFlags >> 16) & 0xff;
        data[offset++] = (appFlags >> 8) & 0xff;
        data[offset++] = appFlags & 0xff;
        
        // App name
        data[offset++] = appName.length;
        data.set(appName, offset);
        offset += appName.length;
        
        // Icon
        if (iconOffset === null) {
            if (icon !== null) {
                data[offset++] = icon.length;
                data.set(icon, offset);
                offset += icon.length;
            } else {
                data[offset++] = 0;
            }
        }
        
        // Path
        if (path !== null) {
            data[offset++] = path.length;
            data.set(path, offset);
            offset += path.length;
        } else {
            data[offset++] = 0;
        }
        
        // Icon offset (if using params section)
        if (iconOffset !== null) {
            data[offset++] = (iconOffset >> 24) & 0xff;
            data[offset++] = (iconOffset >> 16) & 0xff;
            data[offset++] = (iconOffset >> 8) & 0xff;
            data[offset++] = iconOffset & 0xff;
            data[offset++] = (iconSize >> 8) & 0xff;
            data[offset++] = iconSize & 0xff;
        }
        
        // App version
        if (appVersion !== null) {
            data[offset++] = appVersion.length;
            data.set(appVersion, offset);
        }
        
        this.createappParams = null;
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Create app with TLV install parameters
     */
    async createApp(codeLength, apiLevel = 0, dataLength = 0, installParamsLength = 0, flags = 0, bootOffset = 1) {
        console.log('createApp params:', { codeLength, apiLevel, dataLength, installParamsLength, flags, bootOffset });
        
        let params;
        if (apiLevel !== -1) {
            // With API level: struct.pack('>BIIIII', api_level, code_length, data_length, install_params_length, flags, bootOffset)
            params = new Uint8Array(21);
            params[0] = apiLevel;
            // Code length (4 bytes, big-endian)
            params[1] = (codeLength >> 24) & 0xff;
            params[2] = (codeLength >> 16) & 0xff;
            params[3] = (codeLength >> 8) & 0xff;
            params[4] = codeLength & 0xff;
            // Data length (4 bytes, big-endian)
            params[5] = (dataLength >> 24) & 0xff;
            params[6] = (dataLength >> 16) & 0xff;
            params[7] = (dataLength >> 8) & 0xff;
            params[8] = dataLength & 0xff;
            // Install params length (4 bytes, big-endian)
            params[9] = (installParamsLength >> 24) & 0xff;
            params[10] = (installParamsLength >> 16) & 0xff;
            params[11] = (installParamsLength >> 8) & 0xff;
            params[12] = installParamsLength & 0xff;
            // Flags (4 bytes, big-endian)
            params[13] = (flags >> 24) & 0xff;
            params[14] = (flags >> 16) & 0xff;
            params[15] = (flags >> 8) & 0xff;
            params[16] = flags & 0xff;
            // Boot offset (4 bytes, big-endian)
            params[17] = (bootOffset >> 24) & 0xff;
            params[18] = (bootOffset >> 16) & 0xff;
            params[19] = (bootOffset >> 8) & 0xff;
            params[20] = bootOffset & 0xff;
        } else {
            // Without API level: struct.pack('>IIIII', code_length, data_length, install_params_length, flags, bootOffset)
            params = new Uint8Array(20);
            let offset = 0;
            // Code length (4 bytes, big-endian)
            params[offset++] = (codeLength >> 24) & 0xff;
            params[offset++] = (codeLength >> 16) & 0xff;
            params[offset++] = (codeLength >> 8) & 0xff;
            params[offset++] = codeLength & 0xff;
            // Data length (4 bytes, big-endian)
            params[offset++] = (dataLength >> 24) & 0xff;
            params[offset++] = (dataLength >> 16) & 0xff;
            params[offset++] = (dataLength >> 8) & 0xff;
            params[offset++] = dataLength & 0xff;
            // Install params length (4 bytes, big-endian)
            params[offset++] = (installParamsLength >> 24) & 0xff;
            params[offset++] = (installParamsLength >> 16) & 0xff;
            params[offset++] = (installParamsLength >> 8) & 0xff;
            params[offset++] = installParamsLength & 0xff;
            // Flags (4 bytes, big-endian)
            params[offset++] = (flags >> 24) & 0xff;
            params[offset++] = (flags >> 16) & 0xff;
            params[offset++] = (flags >> 8) & 0xff;
            params[offset++] = flags & 0xff;
            // Boot offset (4 bytes, big-endian)
            params[offset++] = (bootOffset >> 24) & 0xff;
            params[offset++] = (bootOffset >> 16) & 0xff;
            params[offset++] = (bootOffset >> 8) & 0xff;
            params[offset++] = bootOffset & 0xff;
        }
        
        this.createappParams = params;
        
        // Build data with command byte 0x0B at front (like Python does)
        const data = new Uint8Array(1 + params.length);
        data[0] = 0x0B;  // CREATE_APP command
        data.set(params, 1);
        
        console.log('createApp data:', bytesToHex(data));
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Delete an app by name
     * @param {Uint8Array} appName 
     */
    async deleteApp(appName) {
        const data = new Uint8Array(2 + appName.length);
        data[0] = 0x0c;
        data[1] = appName.length;
        data.set(appName, 2);
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Delete an app by hash
     * @param {Uint8Array} appFullHash - 32 bytes
     */
    async deleteAppByHash(appFullHash) {
        if (appFullHash.length !== 32) {
            throw new Error('Invalid hash format, sha256 expected');
        }
        const data = new Uint8Array(33);
        data[0] = 0x15;
        data.set(appFullHash, 1);
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Load application from hex file
     * @param {number} eraseU8 
     * @param {number} maxLengthPerApdu 
     * @param {object} hexFile - IntelHexPrinter or similar
     * @param {object} options 
     * @returns {Promise<string>} - SHA256 hash of loaded app
     */
    async load(eraseU8, maxLengthPerApdu, hexFile, options = {}) {
        const {
            reverse = false,
            doCRC = true,
            targetId = null,
            targetVersion = null
        } = options;
        
        if (maxLengthPerApdu > this.maxMtu) {
            maxLengthPerApdu = this.maxMtu;
        }
        
        let initialAddress = 0;
        if (this.relative) {
            initialAddress = hexFile.minAddr();
        }
        
        // Create SHA256 hasher
        const hashData = [];
        
        // Hash target info for modern devices
        if (targetId !== null && (targetId & 0xf) > 3) {
            const tv = targetVersion || '';
            const targetData = new Uint8Array(4 + tv.length);
            targetData[0] = (targetId >> 24) & 0xff;
            targetData[1] = (targetId >> 16) & 0xff;
            targetData[2] = (targetId >> 8) & 0xff;
            targetData[3] = targetId & 0xff;
            if (tv.length > 0) {
                const encoder = new TextEncoder();
                targetData.set(encoder.encode(tv), 4);
            }
            hashData.push(targetData);
        }
        
        // Hash createApp params
        if (this.createappParams) {
            hashData.push(this.createappParams);
        }
        
        // Load all areas
        let areas = hexFile.getAreas();
        if (reverse) {
            areas = [...areas].reverse();
        }
        
        for (const area of areas) {
            const startAddress = area.getStart() - initialAddress;
            const data = area.getData();
            
            if (!this.createpackParams) {
                await this.selectSegment(startAddress);
            }
            
            if (data.length === 0) {
                continue;
            }
            
            if (data.length > 0x10000) {
                throw new Error('Invalid data size for loader');
            }
            
            const crc = this.crc16(data);
            let offset = 0;
            let length = data.length;
            
            if (reverse) {
                offset = length;
            }
            
            while (length > 0) {
                let chunkLen;
                if (length > maxLengthPerApdu - LOAD_SEGMENT_CHUNK_HEADER_LENGTH - MIN_PADDING_LENGTH - SCP_MAC_LENGTH) {
                    chunkLen = maxLengthPerApdu - LOAD_SEGMENT_CHUNK_HEADER_LENGTH - MIN_PADDING_LENGTH - SCP_MAC_LENGTH;
                    if ((chunkLen % 16) !== 0) {
                        chunkLen -= chunkLen % 16;
                    }
                } else {
                    chunkLen = length;
                }
                
                if (this.cleardataBlockLen && (chunkLen % this.cleardataBlockLen)) {
                    if (chunkLen < this.cleardataBlockLen) {
                        throw new Error('Cannot transport data that is not block-aligned');
                    }
                    chunkLen -= chunkLen % this.cleardataBlockLen;
                }
                
                let chunk;
                if (reverse) {
                    chunk = data.slice(offset - chunkLen, offset);
                    if (this.createpackParams) {
                        await this.loadPackSegmentChunk(startAddress + offset - chunkLen, chunk);
                    } else {
                        await this.loadSegmentChunk(offset - chunkLen, chunk);
                    }
                } else {
                    chunk = data.slice(offset, offset + chunkLen);
                    hashData.push(chunk);
                    if (this.createpackParams) {
                        await this.loadPackSegmentChunk(startAddress + offset, chunk);
                    } else {
                        await this.loadSegmentChunk(offset, chunk);
                    }
                }
                
                if (reverse) {
                    offset -= chunkLen;
                } else {
                    offset += chunkLen;
                }
                length -= chunkLen;
            }
            
            if (!this.createpackParams) {
                await this.flushSegment();
            }
            
            if (doCRC) {
                await this.crcSegment(0, data.length, crc);
            }
        }
        
        // Compute final hash
        const totalLen = hashData.reduce((sum, arr) => sum + arr.length, 0);
        const combined = new Uint8Array(totalLen);
        let pos = 0;
        for (const arr of hashData) {
            combined.set(arr, pos);
            pos += arr.length;
        }
        
        return bytesToHex(sha256(combined));
    }

    /**
     * Run the application (alias for boot)
     */
    async run(bootOffset = 1, signature = null) {
        await this.boot(bootOffset, signature);
    }

    /**
     * Reset custom CA
     */
    async resetCustomCA() {
        await this.exchange(this.cla, 0x00, 0x00, 0x00, new Uint8Array([0x13]));
    }

    /**
     * Setup custom CA
     * @param {string} name 
     * @param {Uint8Array} publicKey 
     */
    async setupCustomCA(name, publicKey) {
        const encoder = new TextEncoder();
        const nameBytes = encoder.encode(name);
        const data = new Uint8Array(1 + 1 + nameBytes.length + 1 + publicKey.length);
        let offset = 0;
        data[offset++] = 0x12;
        data[offset++] = nameBytes.length;
        data.set(nameBytes, offset);
        offset += nameBytes.length;
        data[offset++] = publicKey.length;
        data.set(publicKey, offset);
        await this.exchange(this.cla, 0x00, 0x00, 0x00, data);
    }

    /**
     * Run an app by name
     * @param {Uint8Array} name 
     */
    async runApp(name) {
        await this.exchange(this.cla, 0xd8, 0x00, 0x00, name);
    }

    /**
     * Get device version
     * @returns {Promise<object>}
     */
    async getVersion() {
        const response = await this.exchange(this.cla, 0x00, 0x00, 0x00, new Uint8Array([0x10]));
        // Parse version response
        return {
            raw: response
        };
    }

    /**
     * List installed apps
     * @param {boolean} restart 
     * @returns {Promise<Array>}
     */
    async listApp(restart = true) {
        const result = [];
        let offset = 0;
        
        while (true) {
            const p1 = restart ? 0x00 : 0x01;
            restart = false;
            
            const response = await this.exchange(this.cla, 0x00, 0x00, 0x00, new Uint8Array([0x0e]));
            
            if (response.length === 0) {
                break;
            }
            
            // Parse app entries
            offset = 0;
            while (offset < response.length) {
                const item = {};
                
                // Flags (4 bytes)
                item.flags = (response[offset] << 24) | (response[offset + 1] << 16) | 
                            (response[offset + 2] << 8) | response[offset + 3];
                offset += 4;
                
                // Hash code data (32 bytes)
                item.hash_code_data = response.slice(offset, offset + 32);
                offset += 32;
                
                // Hash (32 bytes)
                item.hash = response.slice(offset, offset + 32);
                offset += 32;
                
                // Name
                const nameLen = response[offset++];
                item.name = new TextDecoder().decode(response.slice(offset, offset + nameLen));
                offset += nameLen;
                
                result.push(item);
            }
        }
        
        return result;
    }

    /**
     * Get memory info
     * @returns {Promise<object>}
     */
    async getMemInfo() {
        const response = await this.exchange(this.cla, 0x00, 0x00, 0x00, new Uint8Array([0x11]));
        
        let offset = 0;
        return {
            systemSize: (response[offset] << 24) | (response[offset + 1] << 16) | 
                       (response[offset + 2] << 8) | response[offset + 3],
            applicationsSize: (response[offset + 4] << 24) | (response[offset + 5] << 16) | 
                             (response[offset + 6] << 8) | response[offset + 7],
            freeSize: (response[offset + 8] << 24) | (response[offset + 9] << 16) | 
                     (response[offset + 10] << 8) | response[offset + 11],
            usedAppSlots: (response[offset + 12] << 24) | (response[offset + 13] << 16) | 
                         (response[offset + 14] << 8) | response[offset + 15],
            totalAppSlots: (response[offset + 16] << 24) | (response[offset + 17] << 16) | 
                          (response[offset + 18] << 8) | response[offset + 19]
        };
    }
}

// AES encryption/decryption helpers using Web Crypto API
async function aesEncryptCBC(key, iv, data) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-CBC' },
        false,
        ['encrypt']
    );
    
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: iv },
        cryptoKey,
        data
    );
    
    // Web Crypto adds PKCS7 padding, we need to remove it for raw encryption
    // Actually for CBC mode with our own padding, we need the raw result
    return new Uint8Array(encrypted);
}

// Pure JavaScript AES-ECB for synchronous single-block encryption
// Used for SCP v3 key derivation in constructor
const AES_SBOX = new Uint8Array([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
]);

const AES_RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function aesKeyExpansion(key) {
    // Support AES-128 (16 bytes) and AES-256 (32 bytes)
    const Nk = key.length / 4;  // 4 for AES-128, 8 for AES-256
    const Nr = Nk + 6;          // 10 for AES-128, 14 for AES-256
    const Nb = 4;
    const W = new Uint8Array(4 * Nb * (Nr + 1));
    
    // Copy key into first Nk words
    for (let i = 0; i < key.length; i++) {
        W[i] = key[i];
    }
    
    // Expand key
    for (let i = Nk; i < Nb * (Nr + 1); i++) {
        let temp = W.slice((i - 1) * 4, i * 4);
        
        if (i % Nk === 0) {
            // RotWord + SubWord + Rcon
            const t = temp[0];
            temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[i / Nk - 1];
            temp[1] = AES_SBOX[temp[2]];
            temp[2] = AES_SBOX[temp[3]];
            temp[3] = AES_SBOX[t];
        } else if (Nk > 6 && i % Nk === 4) {
            // Additional SubWord for AES-256
            temp[0] = AES_SBOX[temp[0]];
            temp[1] = AES_SBOX[temp[1]];
            temp[2] = AES_SBOX[temp[2]];
            temp[3] = AES_SBOX[temp[3]];
        }
        
        for (let j = 0; j < 4; j++) {
            W[i * 4 + j] = W[(i - Nk) * 4 + j] ^ temp[j];
        }
    }
    
    return { W, Nr };
}

function aesGfMul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hiBit = a & 0x80;
        a = (a << 1) & 0xff;
        if (hiBit) a ^= 0x1b;
        b >>= 1;
    }
    return p;
}

function aesMixColumn(col) {
    const a = new Uint8Array(4);
    for (let i = 0; i < 4; i++) a[i] = col[i];
    col[0] = aesGfMul(a[0], 2) ^ aesGfMul(a[1], 3) ^ a[2] ^ a[3];
    col[1] = a[0] ^ aesGfMul(a[1], 2) ^ aesGfMul(a[2], 3) ^ a[3];
    col[2] = a[0] ^ a[1] ^ aesGfMul(a[2], 2) ^ aesGfMul(a[3], 3);
    col[3] = aesGfMul(a[0], 3) ^ a[1] ^ a[2] ^ aesGfMul(a[3], 2);
}

function aesEncryptBlock(key, block) {
    const { W, Nr } = aesKeyExpansion(key);
    const state = new Uint8Array(16);
    
    // Copy block to state (column-major)
    for (let i = 0; i < 16; i++) {
        state[i] = block[i];
    }
    
    // AddRoundKey
    for (let i = 0; i < 16; i++) {
        state[i] ^= W[i];
    }
    
    // Rounds
    for (let round = 1; round <= Nr; round++) {
        // SubBytes
        for (let i = 0; i < 16; i++) {
            state[i] = AES_SBOX[state[i]];
        }
        
        // ShiftRows
        let t = state[1];
        state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
        t = state[2]; state[2] = state[10]; state[10] = t;
        t = state[6]; state[6] = state[14]; state[14] = t;
        t = state[3]; state[3] = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = t;
        
        // MixColumns (not in last round)
        if (round < Nr) {
            for (let col = 0; col < 4; col++) {
                const c = state.slice(col * 4, col * 4 + 4);
                aesMixColumn(c);
                state.set(c, col * 4);
            }
        }
        
        // AddRoundKey
        const roundKey = W.slice(round * 16, round * 16 + 16);
        for (let i = 0; i < 16; i++) {
            state[i] ^= roundKey[i];
        }
    }
    
    return state;
}

// AES-CBC encryption without padding (for SCP operations)
// Input MUST be a multiple of 16 bytes
function aesCbcEncryptNoPadding(key, iv, data) {
    if (data.length % 16 !== 0) {
        throw new Error('Data length must be multiple of 16 for CBC without padding');
    }
    
    const result = new Uint8Array(data.length);
    let prevBlock = iv;
    
    for (let i = 0; i < data.length; i += 16) {
        // XOR with previous ciphertext (or IV for first block)
        const block = new Uint8Array(16);
        for (let j = 0; j < 16; j++) {
            block[j] = data[i + j] ^ prevBlock[j];
        }
        
        // Encrypt block
        const encryptedBlock = aesEncryptBlock(key, block);
        result.set(encryptedBlock, i);
        
        // Update previous block for next iteration
        prevBlock = encryptedBlock;
    }
    
    return result;
}

async function aesDecryptCBC(key, iv, data) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    );
    
    // Add PKCS7 padding that Web Crypto expects
    const paddedData = new Uint8Array(data.length + 16);
    paddedData.set(data);
    // Add padding (16 bytes of 0x10)
    for (let i = data.length; i < paddedData.length; i++) {
        paddedData[i] = 16;
    }
    
    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: iv },
            cryptoKey,
            paddedData
        );
        return new Uint8Array(decrypted);
    } catch (e) {
        // If decryption fails due to padding, try without extra padding
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: iv },
            cryptoKey,
            data
        );
        return new Uint8Array(decrypted);
    }
}

// Utility functions
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function bytesToBigInt(bytes) {
    let result = 0n;
    for (const byte of bytes) {
        result = (result << 8n) | BigInt(byte);
    }
    return result;
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export default HexLoader;

// Export AES functions for testing
export { 
    aesEncryptBlock, 
    aesCbcEncryptNoPadding,
    AES_SBOX,
    AES_RCON
};
