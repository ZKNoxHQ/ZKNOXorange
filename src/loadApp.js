/**
 * Load Application onto Ledger Device
 * Port of ledgerblue/loadApp.py
 * 
 * Main entry point for sideloading applications
 */

import { PrivateKey, bytesToHex, hexToBytes } from './ecWrapper.js';
import { IntelHexParser, IntelHexPrinter } from './hexParser.js';
import { 
    HexLoader, 
    encodelv, 
    encodetlv,
    BOLOS_TAG_APPNAME,
    BOLOS_TAG_APPVERSION,
    BOLOS_TAG_ICON,
    BOLOS_TAG_DERIVEPATH,
    BOLOS_TAG_DEPENDENCY
} from './hexLoader.js';
import { getDeployedSecretV2 } from './deployed.js';

// Constants
const DEFAULT_ALIGNMENT = 1024;
const PAGE_ALIGNMENT = 64;

// Target IDs for common devices
export const TARGET_IDS = {
    NANO_S: 0x31100004,
    NANO_S_PLUS: 0x33100004,
    NANO_X: 0x33000004,
    STAX: 0x33200004,
    FLEX: 0x33300004
};

// Curve constants
export const CURVES = {
    SECP256K1: 0x01,
    SECP256R1: 0x02,
    ED25519: 0x04,
    SLIP21: 0x08,
    BLS12381G1: 0x10
};

/**
 * Parse a BIP32 path string to bytes
 * @param {string} path - e.g., "44'/60'/0'/0/0"
 * @returns {Uint8Array}
 */
export function parseBip32Path(path) {
    if (!path || path.length === 0) {
        return new Uint8Array(0);
    }
    
    const elements = path.split('/');
    const result = new Uint8Array(1 + elements.length * 4);
    result[0] = elements.length;
    
    let offset = 1;
    for (const element of elements) {
        let value;
        if (element.endsWith("'") || element.endsWith('h')) {
            value = parseInt(element.slice(0, -1)) | 0x80000000;
        } else {
            value = parseInt(element);
        }
        result[offset++] = (value >> 24) & 0xff;
        result[offset++] = (value >> 16) & 0xff;
        result[offset++] = (value >> 8) & 0xff;
        result[offset++] = value & 0xff;
    }
    
    return result;
}

/**
 * Parse SLIP21 path to bytes
 * @param {string} path 
 * @returns {Uint8Array}
 */
export function parseSlip21Path(path) {
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    const result = new Uint8Array(2 + pathBytes.length);
    result[0] = 0x80 | (pathBytes.length + 1);
    result[1] = 0x00;
    result.set(pathBytes, 2);
    return result;
}

/**
 * Convert string to bytes
 * @param {string} str 
 * @returns {Uint8Array}
 */
function stringToBytes(str) {
    return new TextEncoder().encode(str);
}

/**
 * Concatenate multiple Uint8Arrays
 * @param  {...Uint8Array} arrays 
 * @returns {Uint8Array}
 */
function concatBytes(...arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

/**
 * Load application options
 * @typedef {Object} LoadAppOptions
 * @property {number} targetId - Device target ID
 * @property {string} [targetVersion] - Target version string
 * @property {number} [apiLevel=-1] - API level
 * @property {string} fileName - Path to hex file or hex content
 * @property {Uint8Array} [icon] - Icon data
 * @property {string[]} [curves] - Allowed curves
 * @property {string[]} [paths] - BIP32 paths
 * @property {string[]} [pathSlip21] - SLIP21 paths
 * @property {string} appName - Application name
 * @property {Uint8Array} [signature] - Pre-computed signature
 * @property {boolean} [signApp=false] - Sign with signPrivateKey
 * @property {number} [appFlags=0] - Application flags
 * @property {number} [bootAddr] - Boot address (auto-detected if not provided)
 * @property {string} [rootPrivateKey] - Hex string of root private key
 * @property {string} [signPrivateKey] - Hex string of signing private key
 * @property {boolean} [delete=false] - Delete existing app first
 * @property {boolean} [tlv=true] - Use TLV install params
 * @property {number} [dataSize] - Data section size
 * @property {string} [appVersion] - Application version string
 * @property {Array} [dependencies] - App dependencies
 * @property {boolean} [nocrc=false] - Skip CRC verification
 * @property {boolean} [debug=false] - Enable debug output
 */

/**
 * Load an application onto a Ledger device
 * @param {object} dongle - Transport object
 * @param {LoadAppOptions} options - Load options
 * @returns {Promise<string>} - Application hash
 */
export async function loadApp(dongle, options) {
    const {
        targetId,
        targetVersion = null,
        apiLevel = -1,
        fileName,
        icon = null,
        curves = null,
        paths = null,
        pathSlip21 = null,
        appName,
        signature = null,
        signApp = false,
        appFlags = 0,
        bootAddr: bootAddrOption = null,
        rootPrivateKey: rootPrivateKeyOption = null,
        signPrivateKey = null,
        delete: deleteFirst = false,
        tlv = true,
        dataSize: dataSizeOption = null,
        installParamsSize: installParamsSizeOption = null,
        appVersion = null,
        dependencies = null,
        nocrc = false,
        debug = false
    } = options;

    // Generate or use provided root private key
    // Default: use private key = 1 (matches custom CA with public key = generator G)
    let rootPrivateKey;
    if (rootPrivateKeyOption === null) {
        // Private key = 1 (32 bytes, big-endian)
        rootPrivateKey = new Uint8Array(32);
        rootPrivateKey[31] = 0x01;
        if (debug) {
            console.log(`Using default root private key = 1 (custom CA compatible)`);
        }
    } else {
        rootPrivateKey = typeof rootPrivateKeyOption === 'string' 
            ? hexToBytes(rootPrivateKeyOption) 
            : rootPrivateKeyOption;
    }

    const appNameBytes = stringToBytes(appName);

    // Parse hex file
    const parser = typeof fileName === 'string' && fileName.startsWith(':')
        ? new IntelHexParser(fileName)
        : new IntelHexParser(fileName);
    
    let bootAddr = bootAddrOption;
    if (bootAddr === null) {
        bootAddr = parser.getBootAddr();
    }

    // Build derivation path
    let path = new Uint8Array(0);
    let curveMask = 0xff;

    if (curves !== null) {
        curveMask = 0x00;
        for (const curve of curves) {
            if (curve === 'secp256k1') {
                curveMask |= CURVES.SECP256K1;
            } else if (curve === 'secp256r1') {
                curveMask |= CURVES.SECP256R1;
            } else if (curve === 'ed25519') {
                curveMask |= CURVES.ED25519;
            } else if (curve === 'bls12381g1') {
                curveMask |= CURVES.BLS12381G1;
            } else {
                throw new Error(`Unknown curve: ${curve}`);
            }
        }
    }

    if (pathSlip21 !== null) {
        curveMask |= CURVES.SLIP21;
    }

    path = concatBytes(path, new Uint8Array([curveMask]));

    if (paths !== null) {
        for (const item of paths) {
            if (item.length !== 0) {
                path = concatBytes(path, parseBip32Path(item));
            }
        }
    }

    if (pathSlip21 !== null) {
        for (const item of pathSlip21) {
            if (item.length !== 0) {
                path = concatBytes(path, parseSlip21Path(item));
            }
        }
        if (paths === null || (paths.length === 1 && paths[0].length === 0)) {
            path = concatBytes(path, new Uint8Array([0x00]));
        }
    }

    // Process icon
    let iconData = icon;
    if (iconData !== null && typeof iconData === 'string') {
        iconData = hexToBytes(iconData);
    }

    // Process signature
    let sig = signature;
    if (sig !== null && typeof sig === 'string') {
        sig = hexToBytes(sig);
    }

    // Create printer from parser
    const printer = new IntelHexPrinter(parser);

    // Determine clear data block length for upgrades
    let cleardataBlockLen = null;
    if (appFlags & 2) {
        cleardataBlockLen = 16;
    }

    // Establish secure channel
    if (debug) {
        console.log('Establishing secure channel...');
    }
    const secret = await getDeployedSecretV2(dongle, rootPrivateKey, targetId);

    // Create loader
    const loader = new HexLoader(dongle, 0xe0, true, secret, true, cleardataBlockLen);

    // Delete existing app if requested
    if (!(appFlags & 2) && deleteFirst) {
        if (debug) {
            console.log(`Deleting existing app: ${appName}`);
        }
        try {
            await loader.deleteApp(appNameBytes);
        } catch (e) {
            // Ignore delete errors
            if (debug) {
                console.log(`Delete failed (may not exist): ${e.message}`);
            }
        }
    }

    // Determine data size
    let dataSize = dataSizeOption;
    if (dataSize === null) {
        dataSize = 0;
    }

    if (tlv) {
        // TLV mode
        let codeLength = printer.maxAddr() - printer.minAddr();
        if (dataSizeOption !== null) {
            codeLength -= dataSizeOption;
        }

        let installParams = new Uint8Array(0);

        // Add dependencies
        if (dependencies) {
            for (const dep of dependencies) {
                let depAppName = dep;
                let depAppVersion = null;
                if (dep.includes(':')) {
                    [depAppName, depAppVersion] = dep.split(':');
                }
                let depValue = encodelv(stringToBytes(depAppName));
                if (depAppVersion) {
                    depValue = concatBytes(depValue, encodelv(stringToBytes(depAppVersion)));
                }
                installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_DEPENDENCY, depValue));
            }
        }

        // Only build and append install params if installParamsSize is NOT provided
        // Python: if (not (args.appFlags & 2)) and ( args.installparamsSize is None or args.installparamsSize == 0 )
        const shouldBuildInstallParams = !(appFlags & 2) && 
            (installParamsSizeOption === null || installParamsSizeOption === 0);
        
        if (shouldBuildInstallParams) {
            // Build install parameters
            installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_APPNAME, appNameBytes));
            
            if (appVersion !== null) {
                installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_APPVERSION, stringToBytes(appVersion)));
            }
            
            if (iconData !== null) {
                installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_ICON, iconData));
            }
            
            if (path.length > 0) {
                installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_DERIVEPATH, path));
            }

            // Append install params to loaded file
            const paramStart = printer.maxAddr() + 
                (PAGE_ALIGNMENT - (dataSize % PAGE_ALIGNMENT)) % PAGE_ALIGNMENT;
            printer.addArea(paramStart, installParams);
        }

        // Use explicit installParamsSize if provided, otherwise use calculated length
        // When installParamsSize is explicit, also subtract it from codeLength (like Python)
        let paramsSize;
        if (installParamsSizeOption !== null && installParamsSizeOption > 0) {
            paramsSize = installParamsSizeOption;
            // Python: code_length -= args.installparamsSize
            codeLength -= installParamsSizeOption;
        } else {
            paramsSize = installParams.length;
        }

        // Boot offset is RELATIVE to minAddr, not absolute!
        // Python: boot_offset = printer.getEntryPoint() - printer.minAddr()
        const bootOffset = (bootAddr - printer.minAddr()) | 1;

        // Create app
        if (debug) {
            console.log(`Creating app: code=${codeLength}, data=${dataSize}, params=${paramsSize}, bootOffset=${bootOffset}`);
        }
        await loader.createApp(
            codeLength,
            apiLevel,
            dataSize,
            paramsSize,
            appFlags,
            bootOffset
        );
    } else {
        // Legacy mode
        const appLength = printer.maxAddr() - printer.minAddr();
        await loader.createAppNoInstallParams(
            appFlags,
            appLength,
            appNameBytes,
            iconData,
            path,
            null,
            null,
            appVersion ? stringToBytes(appVersion) : null
        );
    }

    // Load the app
    if (debug) {
        console.log('Loading application...');
    }
    const hash = await loader.load(0x00, 0xf0, printer, {
        targetId: targetId,
        targetVersion: targetVersion,
        doCRC: !nocrc
    });

    if (debug) {
        console.log(`Application full hash: ${hash}`);
    }

    // Sign if requested
    if (sig === null && signApp && signPrivateKey) {
        const masterPrivate = new PrivateKey(hexToBytes(signPrivateKey));
        const sigObj = masterPrivate.ecdsaSign(hexToBytes(hash), true);
        sig = masterPrivate.ecdsaSerialize(sigObj);
        if (debug) {
            console.log(`Application signature: ${bytesToHex(sig)}`);
        }
    }

    // Commit/run
    if (tlv) {
        await loader.commit(sig);
    } else {
        await loader.run(bootAddr - printer.minAddr(), sig);
    }

    return hash;
}

/**
 * Delete an application from a Ledger device
 * @param {object} dongle - Transport object
 * @param {string} appName - Application name to delete
 * @param {number} targetId - Device target ID
 * @param {string} [rootPrivateKey] - Root private key (hex)
 * @param {boolean} [debug=false] - Enable debug output
 */
export async function deleteApp(dongle, appName, targetId, rootPrivateKey = null, debug = false) {
    // Generate or use provided root private key
    // Default: use private key = 1 (matches custom CA)
    let rootKey;
    if (rootPrivateKey === null) {
        rootKey = new Uint8Array(32);
        rootKey[31] = 0x01;
    } else {
        rootKey = typeof rootPrivateKey === 'string' ? hexToBytes(rootPrivateKey) : rootPrivateKey;
    }

    // Establish secure channel
    const secret = await getDeployedSecretV2(dongle, rootKey, targetId);

    // Create loader
    const loader = new HexLoader(dongle, 0xe0, true, secret);

    // Delete app
    const appNameBytes = stringToBytes(appName);
    await loader.deleteApp(appNameBytes);

    if (debug) {
        console.log(`Deleted app: ${appName}`);
    }
}

/**
 * List installed applications
 * @param {object} dongle - Transport object
 * @param {number} targetId - Device target ID
 * @param {string} [rootPrivateKey] - Root private key (hex)
 * @returns {Promise<Array>} - List of installed apps
 */
export async function listApps(dongle, targetId, rootPrivateKey = null) {
    // Generate or use provided root private key
    // Default: use private key = 1 (matches custom CA)
    let rootKey;
    if (rootPrivateKey === null) {
        rootKey = new Uint8Array(32);
        rootKey[31] = 0x01;
    } else {
        rootKey = typeof rootPrivateKey === 'string' ? hexToBytes(rootPrivateKey) : rootPrivateKey;
    }

    // Establish secure channel
    const secret = await getDeployedSecretV2(dongle, rootKey, targetId);

    // Create loader
    const loader = new HexLoader(dongle, 0xe0, true, secret);

    // List apps
    return await loader.listApp();
}

/**
 * Get device memory info
 * @param {object} dongle - Transport object
 * @param {number} targetId - Device target ID
 * @param {string} [rootPrivateKey] - Root private key (hex)
 * @returns {Promise<object>} - Memory info
 */
export async function getMemInfo(dongle, targetId, rootPrivateKey = null) {
    // Generate or use provided root private key
    // Default: use private key = 1 (matches custom CA)
    let rootKey;
    if (rootPrivateKey === null) {
        rootKey = new Uint8Array(32);
        rootKey[31] = 0x01;
    } else {
        rootKey = typeof rootPrivateKey === 'string' ? hexToBytes(rootPrivateKey) : rootPrivateKey;
    }

    // Establish secure channel
    const secret = await getDeployedSecretV2(dongle, rootKey, targetId);

    // Create loader
    const loader = new HexLoader(dongle, 0xe0, true, secret);

    // Get mem info
    return await loader.getMemInfo();
}

export default loadApp;
