/**
 * Secure Channel Protocol (SCP) Establishment
 * Port of ledgerblue/deployed.py
 * 
 * Handles ECDH key exchange and certificate chain validation with Ledger devices
 */

import { PrivateKey, PublicKey, bytesToHex, hexToBytes } from './ecWrapper.js';
import { randomBytes } from '@noble/hashes/utils';

/**
 * Establish SCP V1 session (legacy, pre Nano S 1.4)
 * @param {object} dongle - Transport object with exchange() method
 * @param {Uint8Array} masterPrivate - Master private key (32 bytes)
 * @param {number} targetId - Device target ID
 * @returns {Promise<Uint8Array>} - Session key (16 bytes)
 */
export async function getDeployedSecretV1(dongle, masterPrivate, targetId) {
    const testMaster = new PrivateKey(masterPrivate);
    const testMasterPublic = testMaster.pubkey.serialize(false);
    const targetIdBytes = uint32ToBytes(targetId);

    if ((targetId & 0xf) !== 0x1) {
        throw new Error('Target ID does not support SCP V1');
    }

    // Identify device
    let apdu = new Uint8Array([0xe0, 0x04, 0x00, 0x00, targetIdBytes.length, ...targetIdBytes]);
    await dongle.exchange(apdu);

    // Walk the chain
    const batchInfo = await dongle.exchange(hexToBytes('e050000000'));
    const cardKeyLen = batchInfo[4];
    const cardKey = batchInfo.slice(5, 5 + cardKeyLen);

    // Generate ephemeral key pair
    const ephemeralPrivate = new PrivateKey();
    const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
    console.log('Using ephemeral key ' + bytesToHex(ephemeralPublic));

    // Sign ephemeral public key with master key
    const signature = testMaster.ecdsaSign(ephemeralPublic);
    const signatureDer = testMaster.ecdsaSerialize(signature);

    // Build certificate
    const certificate = new Uint8Array([
        ephemeralPublic.length,
        ...ephemeralPublic,
        signatureDer.length,
        ...signatureDer
    ]);

    apdu = new Uint8Array([0xe0, 0x51, 0x00, 0x00, certificate.length, ...certificate]);
    await dongle.exchange(apdu);

    // Walk device certificates to get public key for authentication
    let lastPubKey = new PublicKey(testMasterPublic, true);
    let index = 0;

    while (true) {
        const certResponse = await dongle.exchange(hexToBytes('e052000000'));
        if (certResponse.length === 0) {
            break;
        }

        const certPublicLen = certResponse[0];
        const certPublic = certResponse.slice(1, 1 + certPublicLen);
        const certSigStart = 2 + certPublicLen;
        const certSignature = certResponse.slice(certSigStart);

        const certSig = lastPubKey.ecdsaDeserialize(certSignature);

        if (!lastPubKey.ecdsaVerify(certPublic, certSig)) {
            if (index === 0) {
                console.log('Broken certificate chain - loading from user key');
            } else {
                throw new Error('Broken certificate chain');
            }
        }

        lastPubKey = new PublicKey(certPublic, true);
        index++;
    }

    // Commit ECDH channel
    await dongle.exchange(hexToBytes('e053000000'));

    // Compute shared secret
    const ephemeralPrivBytes = hexToBytes(ephemeralPrivate.serialize());
    const secret = lastPubKey.ecdh(ephemeralPrivBytes);

    return secret.slice(0, 16);
}

/**
 * Establish SCP V2/V3 session (Nano S 1.4+, all modern devices)
 * @param {object} dongle - Transport object with exchange() method
 * @param {Uint8Array} masterPrivate - Master private key (32 bytes)
 * @param {number} targetId - Device target ID
 * @param {Array|null} signerCertChain - Optional signer certificate chain
 * @param {number|null} ecdhSecretFormat - Force specific ECDH format
 * @returns {Promise<Uint8Array|object>} - Session key or object with ecdh_secret and devicePublicKey
 */
export async function getDeployedSecretV2(dongle, masterPrivate, targetId, signerCertChain = null, ecdhSecretFormat = null) {
    const testMaster = new PrivateKey(masterPrivate);
    const testMasterPublic = testMaster.pubkey.serialize(false);
    const targetIdBytes = uint32ToBytes(targetId);

    if ((targetId & 0xf) < 2) {
        throw new Error('Target ID does not support SCP V2');
    }

    // Identify device
    console.log('SCP: Sending IDENTIFY (E004)');
    let apdu = new Uint8Array([0xe0, 0x04, 0x00, 0x00, targetIdBytes.length, ...targetIdBytes]);
    console.log('SCP: APDU =', bytesToHex(apdu));
    let response = await dongle.exchange(apdu);
    console.log('SCP: Response =', bytesToHex(response));

    // Walk the chain with nonce exchange
    const nonce = randomBytes(8);
    console.log('SCP: Sending GET_NONCE (E050) with nonce =', bytesToHex(nonce));
    apdu = new Uint8Array([0xe0, 0x50, 0x00, 0x00, nonce.length, ...nonce]);
    console.log('SCP: APDU =', bytesToHex(apdu));
    const authInfo = await dongle.exchange(apdu);
    console.log('SCP: Response (authInfo) =', bytesToHex(authInfo));
    
    const batchSignerSerial = authInfo.slice(0, 4);
    const deviceNonce = authInfo.slice(4, 12);
    console.log('SCP: batchSignerSerial =', bytesToHex(batchSignerSerial));
    console.log('SCP: deviceNonce =', bytesToHex(deviceNonce));

    // Send signer certificate(s)
    if (signerCertChain) {
        for (const cert of signerCertChain) {
            apdu = new Uint8Array([0xe0, 0x51, 0x00, 0x00, cert.length, ...cert]);
            await dongle.exchange(apdu);
        }
    } else {
        console.log('SCP: Using test master key =', bytesToHex(testMasterPublic));

        // Self-signed master certificate
        // Data to sign: 0x01 || masterPublicKey
        const dataToSign = new Uint8Array([0x01, ...testMasterPublic]);
        console.log('SCP: Master cert data to sign =', bytesToHex(dataToSign));
        const signature = testMaster.ecdsaSign(dataToSign);
        const signatureDer = testMaster.ecdsaSerialize(signature);
        console.log('SCP: Master cert signature (DER) =', bytesToHex(signatureDer));

        const certificate = new Uint8Array([
            testMasterPublic.length,
            ...testMasterPublic,
            signatureDer.length,
            ...signatureDer
        ]);
        console.log('SCP: Master certificate =', bytesToHex(certificate));

        console.log('SCP: Sending VALIDATE_CERT (E051) for master cert');
        apdu = new Uint8Array([0xe0, 0x51, 0x00, 0x00, certificate.length, ...certificate]);
        console.log('SCP: APDU =', bytesToHex(apdu));
        response = await dongle.exchange(apdu);
        console.log('SCP: Response =', bytesToHex(response));
    }

    // Generate and send ephemeral key certificate
    const ephemeralPrivate = new PrivateKey();
    const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
    console.log('SCP: Using ephemeral key =', bytesToHex(ephemeralPublic));

    // Data to sign: 0x11 || nonce || deviceNonce || ephemeralPublic
    const ephDataToSign = new Uint8Array([
        0x11,
        ...nonce,
        ...deviceNonce,
        ...ephemeralPublic
    ]);
    console.log('SCP: Ephemeral cert data to sign =', bytesToHex(ephDataToSign));
    const ephSignature = testMaster.ecdsaSign(ephDataToSign);
    const ephSignatureDer = testMaster.ecdsaSerialize(ephSignature);
    console.log('SCP: Ephemeral cert signature (DER) =', bytesToHex(ephSignatureDer));

    const ephCertificate = new Uint8Array([
        ephemeralPublic.length,
        ...ephemeralPublic,
        ephSignatureDer.length,
        ...ephSignatureDer
    ]);
    console.log('SCP: Ephemeral certificate =', bytesToHex(ephCertificate));

    // P1 = 0x80 indicates this is the last certificate
    console.log('SCP: Sending VALIDATE_CERT (E051 P1=0x80) for ephemeral cert');
    apdu = new Uint8Array([0xe0, 0x51, 0x80, 0x00, ephCertificate.length, ...ephCertificate]);
    console.log('SCP: APDU =', bytesToHex(apdu));
    response = await dongle.exchange(apdu);
    console.log('SCP: Response =', bytesToHex(response));

    // Walk device certificates
    let lastDevPubKey = new PublicKey(testMasterPublic, true);
    let devicePublicKey = null;
    let index = 0;

    while (true) {
        let certResponse;
        if (index === 0) {
            certResponse = await dongle.exchange(hexToBytes('e052000000'));
        } else if (index === 1) {
            certResponse = await dongle.exchange(hexToBytes('e052800000'));
        } else {
            break;
        }

        if (certResponse.length === 0) {
            break;
        }

        let offset = 1;
        const headerLen = certResponse[offset - 1];
        const certHeader = certResponse.slice(offset, offset + headerLen);
        offset += headerLen + 1;

        const pubKeyLen = certResponse[offset - 1];
        const certPublicKey = certResponse.slice(offset, offset + pubKeyLen);
        offset += pubKeyLen + 1;

        const sigLen = certResponse[offset - 1];
        const certSignatureArray = certResponse.slice(offset, offset + sigLen);

        const certSignature = lastDevPubKey.ecdsaDeserialize(certSignatureArray);

        let certSignedData;
        if (index === 0) {
            // First cert: device certificate
            devicePublicKey = certPublicKey;
            certSignedData = new Uint8Array([0x02, ...certHeader, ...certPublicKey]);
        } else {
            // Second cert: ephemeral key from device
            certSignedData = new Uint8Array([0x12, ...deviceNonce, ...nonce, ...certPublicKey]);
        }

        if (!lastDevPubKey.ecdsaVerify(certSignedData, certSignature)) {
            if (index === 0) {
                console.log('Broken certificate chain - loading from user key');
            } else {
                throw new Error('Broken certificate chain');
            }
        }

        lastDevPubKey = new PublicKey(certPublicKey, true);
        index++;
    }

    // Commit ECDH channel
    await dongle.exchange(hexToBytes('e053000000'));

    // Compute shared secret
    // CRITICAL: Python's deployed.py calls ecdh() WITHOUT scpv3 parameter,
    // which defaults to scpv3=False (compressed point format, 33 bytes).
    // We MUST use the same format to get the same shared secret!
    const ephemeralPrivBytes = hexToBytes(ephemeralPrivate.serialize());
    console.log('SCP: Device ephemeral pubkey for ECDH:', bytesToHex(lastDevPubKey.serialize(false)));
    console.log('SCP: Our ephemeral private key:', ephemeralPrivate.serialize());
    console.log('SCP: Using COMPRESSED POINT format (scpv3=false) to match Python');
    const secret = lastDevPubKey.ecdh(ephemeralPrivBytes, false);  // MUST be false to match Python
    console.log('SCP: ECDH secret (raw):', bytesToHex(secret));

    // Return format depends on target ID and requested format
    if (ecdhSecretFormat === 1 || (targetId & 0xf) === 0x2) {
        return secret.slice(0, 16);
    } else if ((targetId & 0xf) >= 0x3) {
        return {
            ecdh_secret: secret,
            devicePublicKey: devicePublicKey
        };
    }

    return secret.slice(0, 16);
}

/**
 * Convert uint32 to big-endian bytes
 * @param {number} value 
 * @returns {Uint8Array}
 */
function uint32ToBytes(value) {
    return new Uint8Array([
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff
    ]);
}

export default { getDeployedSecretV1, getDeployedSecretV2 };
