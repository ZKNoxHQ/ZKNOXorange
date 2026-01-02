/**
 * Elliptic Curve Wrapper for secp256k1
 * Port of ledgerblue/ecWrapper.py
 * 
 * Uses @noble/secp256k1 for cryptographic operations
 */

import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { randomBytes } from '@noble/hashes/utils';

// Configure secp256k1 to use our hash functions
secp256k1.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp256k1.etc.concatBytes(...m));

/**
 * Convert compact signature (64 bytes r||s) to DER format
 * @param {Uint8Array} compact - 64 byte compact signature
 * @returns {Uint8Array} - DER encoded signature
 */
function compactToDER(compact) {
    const r = compact.slice(0, 32);
    const s = compact.slice(32, 64);
    
    // Remove leading zeros but keep at least one byte
    let rStart = 0;
    while (rStart < r.length - 1 && r[rStart] === 0) rStart++;
    let rBytes = r.slice(rStart);
    
    let sStart = 0;
    while (sStart < s.length - 1 && s[sStart] === 0) sStart++;
    let sBytes = s.slice(sStart);
    
    // Add 0x00 prefix if high bit is set (to indicate positive number)
    if (rBytes[0] & 0x80) {
        const newR = new Uint8Array(rBytes.length + 1);
        newR[0] = 0;
        newR.set(rBytes, 1);
        rBytes = newR;
    }
    if (sBytes[0] & 0x80) {
        const newS = new Uint8Array(sBytes.length + 1);
        newS[0] = 0;
        newS.set(sBytes, 1);
        sBytes = newS;
    }
    
    // Build DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
    const totalLen = 2 + rBytes.length + 2 + sBytes.length;
    const der = new Uint8Array(2 + totalLen);
    let offset = 0;
    
    der[offset++] = 0x30; // SEQUENCE
    der[offset++] = totalLen;
    der[offset++] = 0x02; // INTEGER
    der[offset++] = rBytes.length;
    der.set(rBytes, offset);
    offset += rBytes.length;
    der[offset++] = 0x02; // INTEGER
    der[offset++] = sBytes.length;
    der.set(sBytes, offset);
    
    return der;
}

/**
 * Parse DER signature to r and s values
 * @param {Uint8Array} der - DER encoded signature
 * @returns {{r: bigint, s: bigint}}
 */
function derToRS(der) {
    if (der[0] !== 0x30) throw new Error('Invalid DER signature');
    let offset = 2;
    
    if (der[offset] !== 0x02) throw new Error('Invalid DER signature');
    offset++;
    const rLen = der[offset++];
    const rBytes = der.slice(offset, offset + rLen);
    offset += rLen;
    
    if (der[offset] !== 0x02) throw new Error('Invalid DER signature');
    offset++;
    const sLen = der[offset++];
    const sBytes = der.slice(offset, offset + sLen);
    
    return {
        r: bytesToBigInt(rBytes),
        s: bytesToBigInt(sBytes)
    };
}

/**
 * PublicKey class - wraps secp256k1 public key operations
 */
export class PublicKey {
    /**
     * @param {Uint8Array} pubkey - Public key bytes (65 bytes uncompressed with 0x04 prefix)
     * @param {boolean} raw - If true, pubkey is raw bytes
     */
    constructor(pubkey = null, raw = false) {
        if (pubkey === null) {
            this._point = null;
        } else if (raw) {
            this._pubkeyBytes = new Uint8Array(pubkey);
            if (pubkey[0] === 0x04 && pubkey.length === 65) {
                this._point = secp256k1.ProjectivePoint.fromHex(pubkey);
            } else if ((pubkey[0] === 0x02 || pubkey[0] === 0x03) && pubkey.length === 33) {
                this._point = secp256k1.ProjectivePoint.fromHex(pubkey);
            } else {
                throw new Error('Invalid public key format');
            }
        } else {
            throw new Error('Non-raw init not supported');
        }
    }

    /**
     * Serialize the public key
     * @param {boolean} compressed - If true, return 33-byte compressed format
     * @returns {Uint8Array}
     */
    serialize(compressed = true) {
        if (compressed) {
            return this._point.toRawBytes(true);
        } else {
            return this._point.toRawBytes(false);
        }
    }

    /**
     * Deserialize an ECDSA signature from DER format
     * @param {Uint8Array} serSig - Serialized DER signature
     * @returns {secp256k1.Signature} - Signature object for verification
     */
    ecdsaDeserialize(serSig) {
        const { r, s } = derToRS(serSig);
        return new secp256k1.Signature(r, s);
    }

    /**
     * Perform ECDH key exchange
     * @param {Uint8Array} scalar - Private key scalar (32 bytes)
     * @param {boolean} scpv3 - Use SCP v3 format (X+counter instead of compressed point)
     * @returns {Uint8Array} - Shared secret (32 bytes, SHA256 hashed)
     */
    ecdh(scalar, scpv3 = false) {
        const sharedPoint = this._point.multiply(bytesToBigInt(scalar));
        
        let data;
        if (!scpv3) {
            // SCP v2 / Default: SHA256(compressed point)
            // Compressed point = 33 bytes (02/03 prefix + X coordinate)
            // This is what Python's deployed.py uses!
            data = sharedPoint.toRawBytes(true);  // true = compressed
            console.log('ECDH: Using COMPRESSED POINT format (33 bytes):', bytesToHex(data));
        } else {
            // SCP v3 alternate: SHA256(X coordinate + counter)
            // X coordinate (32 bytes) + counter (4 bytes, 0x00000001) = 36 bytes
            // WARNING: Python does NOT use this format by default!
            const xBytes = bigIntToBytes(sharedPoint.x, 32);
            data = new Uint8Array(36);
            data.set(xBytes, 0);
            data[32] = 0x00;
            data[33] = 0x00;
            data[34] = 0x00;
            data[35] = 0x01;
            console.log('ECDH: Using X+COUNTER format (36 bytes):', bytesToHex(data));
        }
        
        const result = sha256(data);
        console.log('ECDH: Secret (SHA256):', bytesToHex(result));
        return result;
    }

    /**
     * Tweak the public key by adding a scalar * G
     * @param {Uint8Array} scalar - Scalar to add
     */
    tweakAdd(scalar) {
        const scalarBigInt = bytesToBigInt(scalar);
        const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(scalarBigInt);
        this._point = this._point.add(tweakPoint);
    }

    /**
     * Verify an ECDSA signature
     * @param {Uint8Array} msg - Message that was signed
     * @param {*} rawSig - Signature (Signature object or DER bytes)
     * @param {boolean} raw - If true, msg is already hashed
     * @param {function} digest - Hash function to use
     * @returns {boolean}
     */
    ecdsaVerify(msg, rawSig, raw = false, digest = sha256) {
        let msgHash;
        if (raw) {
            msgHash = msg;
        } else {
            msgHash = digest(msg);
        }

        let sig;
        if (rawSig instanceof secp256k1.Signature) {
            sig = rawSig;
        } else if (rawSig instanceof Uint8Array) {
            // Assume DER format
            sig = this.ecdsaDeserialize(rawSig);
        } else {
            sig = rawSig;
        }

        // Use pubkey bytes for verification (not the point)
        const pubkeyBytes = this._point.toRawBytes(false);
        return secp256k1.verify(sig, msgHash, pubkeyBytes);
    }
}

/**
 * PrivateKey class - wraps secp256k1 private key operations
 */
export class PrivateKey {
    /**
     * @param {Uint8Array|null} privkey - Private key bytes (32 bytes) or null to generate
     * @param {boolean} raw - Must be true
     */
    constructor(privkey = null, raw = true) {
        if (!raw) {
            throw new Error('Non-raw init not supported');
        }

        if (privkey === null) {
            this._privateKey = secp256k1.utils.randomPrivateKey();
        } else {
            this._privateKey = new Uint8Array(privkey);
        }

        const pubkeyBytes = secp256k1.getPublicKey(this._privateKey, false);
        this.pubkey = new PublicKey(pubkeyBytes, true);
    }

    /**
     * Serialize the private key as hex string
     * @returns {string}
     */
    serialize() {
        return bytesToHex(this._privateKey);
    }

    /**
     * Get raw private key bytes
     * @returns {Uint8Array}
     */
    getPrivateKeyBytes() {
        return this._privateKey;
    }

    /**
     * Serialize an ECDSA signature to DER format
     * @param {*} rawSig - Signature object
     * @returns {Uint8Array}
     */
    ecdsaSerialize(rawSig) {
        // Check if it's a Signature object with toCompactRawBytes
        if (rawSig && typeof rawSig.toCompactRawBytes === 'function') {
            const compact = rawSig.toCompactRawBytes();
            return compactToDER(compact);
        }
        // Already bytes
        if (rawSig instanceof Uint8Array) {
            return rawSig;
        }
        return rawSig;
    }

    /**
     * Sign a message with ECDSA
     * @param {Uint8Array} msg - Message to sign
     * @param {boolean} raw - If true, msg is already hashed
     * @param {function} digest - Hash function to use
     * @param {boolean} rfc6979 - Use deterministic nonce (always true in noble)
     * @returns {Signature}
     */
    ecdsaSign(msg, raw = false, digest = sha256, rfc6979 = false) {
        let msgHash;
        if (raw) {
            msgHash = msg;
        } else {
            msgHash = digest(msg);
        }

        // noble/secp256k1 always uses RFC6979
        const sig = secp256k1.sign(msgHash, this._privateKey);
        return sig;
    }
}

// Utility functions

/**
 * Convert bytes to BigInt (big endian)
 * @param {Uint8Array} bytes 
 * @returns {bigint}
 */
function bytesToBigInt(bytes) {
    let result = 0n;
    for (const byte of bytes) {
        result = (result << 8n) | BigInt(byte);
    }
    return result;
}

/**
 * Convert BigInt to bytes (big endian)
 * @param {bigint} num 
 * @param {number} length 
 * @returns {Uint8Array}
 */
function bigIntToBytes(num, length) {
    const bytes = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
    }
    return bytes;
}

/**
 * Convert bytes to hex string
 * @param {Uint8Array} bytes 
 * @returns {string}
 */
export function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Convert hex string to bytes
 * @param {string} hex 
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
    if (hex.length % 2 !== 0) {
        throw new Error('Hex string must have even length');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export default { PrivateKey, PublicKey, bytesToHex, hexToBytes };
