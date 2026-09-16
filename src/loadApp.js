import { hashes, utils } from '@noble/secp256k1';
import { PrivateKey, bytesToHex, hexToBytes } from './ecWrapper.js';
import { IntelHexParser, IntelHexPrinter } from './hexParser.js';
import { BOLOS_TAG_APPNAME, BOLOS_TAG_APPVERSION, BOLOS_TAG_DEPENDENCY, BOLOS_TAG_DERIVEPATH, BOLOS_TAG_ICON, HexLoader, encodelv, encodetlv } from './hexLoader.js';
import { getDeployedSecretV2 } from './deployed.js';

var PAGE_ALIGNMENT = 64;
export var TARGET_IDS = {
  NANO_S: 823132164,
  NANO_S_PLUS: 856686596,
  NANO_X: 855638020,
  STAX: 857735172,
  FLEX: 858783748
};
export var CURVES = {
  SECP256K1: 1,
  SECP256R1: 2,
  ED25519: 4,
  SLIP21: 8,
  BLS12381G1: 16
};
export function parseBip32Path(path) {
  if (!path || path.length === 0) {
    return new Uint8Array(0);
  }
  const elements = path.split("/");
  const result = new Uint8Array(1 + elements.length * 4);
  result[0] = elements.length;
  let offset = 1;
  for (const element of elements) {
    let value;
    if (element.endsWith("'") || element.endsWith("h")) {
      value = parseInt(element.slice(0, -1)) | 2147483648;
    } else {
      value = parseInt(element);
    }
    result[offset++] = value >> 24 & 255;
    result[offset++] = value >> 16 & 255;
    result[offset++] = value >> 8 & 255;
    result[offset++] = value & 255;
  }
  return result;
}
function parseSlip21Path(path) {
  const encoder = new TextEncoder();
  const pathBytes = encoder.encode(path);
  const result = new Uint8Array(2 + pathBytes.length);
  result[0] = 128 | pathBytes.length + 1;
  result[1] = 0;
  result.set(pathBytes, 2);
  return result;
}
function stringToBytes(str) {
  return new TextEncoder().encode(str);
}
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
  let rootPrivateKey;
  if (rootPrivateKeyOption === null) {
    const tempKey = new PrivateKey();
    rootPrivateKey = tempKey.getPrivateKeyBytes();
    if (debug) {
      console.log(`Generated random root public key: ${bytesToHex(tempKey.pubkey.serialize(false))}`);
    }
  } else {
    rootPrivateKey = typeof rootPrivateKeyOption === "string" ? hexToBytes(rootPrivateKeyOption) : rootPrivateKeyOption;
  }
  const appNameBytes = stringToBytes(appName);
  const parser = typeof fileName === "string" && fileName.startsWith(":") ? new IntelHexParser(fileName) : new IntelHexParser(fileName);
  let bootAddr = bootAddrOption;
  if (bootAddr === null) {
    bootAddr = parser.getBootAddr();
  }
  let path = new Uint8Array(0);
  let curveMask = 255;
  if (curves !== null) {
    curveMask = 0;
    for (const curve of curves) {
      if (curve === "secp256k1") {
        curveMask |= CURVES.SECP256K1;
      } else if (curve === "secp256r1") {
        curveMask |= CURVES.SECP256R1;
      } else if (curve === "ed25519") {
        curveMask |= CURVES.ED25519;
      } else if (curve === "bls12381g1") {
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
    if (paths === null || paths.length === 1 && paths[0].length === 0) {
      path = concatBytes(path, new Uint8Array([0]));
    }
  }
  let iconData = icon;
  if (iconData !== null && typeof iconData === "string") {
    iconData = hexToBytes(iconData);
  }
  let sig = signature;
  if (sig !== null && typeof sig === "string") {
    sig = hexToBytes(sig);
  }
  const printer = new IntelHexPrinter(parser);
  let cleardataBlockLen = null;
  if (appFlags & 2) {
    cleardataBlockLen = 16;
  }
  if (debug) {
    console.log("Establishing secure channel...");
  }
  const secret = await getDeployedSecretV2(dongle, rootPrivateKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret, true, cleardataBlockLen);
  if (!(appFlags & 2) && deleteFirst) {
    if (debug) {
      console.log(`Deleting existing app: ${appName}`);
    }
    try {
      await loader.deleteApp(appNameBytes);
    } catch (e) {
      if (debug) {
        console.log(`Delete failed (may not exist): ${e.message}`);
      }
    }
  }
  let dataSize = dataSizeOption;
  if (dataSize === null) {
    dataSize = 0;
  }
  if (tlv) {
    let codeLength = printer.maxAddr() - printer.minAddr();
    if (dataSizeOption !== null) {
      codeLength -= dataSizeOption;
    }
    let installParams = new Uint8Array(0);
    if (dependencies) {
      for (const dep of dependencies) {
        let depAppName = dep;
        let depAppVersion = null;
        if (dep.includes(":")) {
          [depAppName, depAppVersion] = dep.split(":");
        }
        let depValue = encodelv(stringToBytes(depAppName));
        if (depAppVersion) {
          depValue = concatBytes(depValue, encodelv(stringToBytes(depAppVersion)));
        }
        installParams = concatBytes(installParams, encodetlv(BOLOS_TAG_DEPENDENCY, depValue));
      }
    }
    const shouldBuildInstallParams = !(appFlags & 2) && (installParamsSizeOption === null || installParamsSizeOption === 0);
    if (shouldBuildInstallParams) {
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
      const paramStart = printer.maxAddr() + (PAGE_ALIGNMENT - dataSize % PAGE_ALIGNMENT) % PAGE_ALIGNMENT;
      printer.addArea(paramStart, installParams);
    }
    let paramsSize;
    if (installParamsSizeOption !== null && installParamsSizeOption > 0) {
      paramsSize = installParamsSizeOption;
      codeLength -= installParamsSizeOption;
    } else {
      paramsSize = installParams.length;
    }
    let bootOffset = bootAddr;
    if (bootAddr > printer.minAddr()) {
      bootOffset = bootAddr - printer.minAddr();
    }
    bootOffset |= 1;
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
  if (debug) {
    console.log("Loading application...");
  }
  const hash = await loader.load(0, 240, printer, {
    targetId,
    targetVersion,
    doCRC: !nocrc
  });
  if (debug) {
    console.log(`Application full hash: ${hash}`);
  }
  if (sig === null && signApp && signPrivateKey) {
    const masterPrivate = new PrivateKey(hexToBytes(signPrivateKey));
    const sigObj = masterPrivate.ecdsaSign(hexToBytes(hash), true);
    sig = masterPrivate.ecdsaSerialize(sigObj);
    if (debug) {
      console.log(`Application signature: ${bytesToHex(sig)}`);
    }
  }
  if (tlv) {
    await loader.commit(sig);
  } else {
    await loader.run(bootAddr - printer.minAddr(), sig);
  }
  return hash;
}
export async function deleteApp(dongle, appName, targetId, rootPrivateKey = null, debug = false) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  const appNameBytes = stringToBytes(appName);
  await loader.deleteApp(appNameBytes);
  if (debug) {
    console.log(`Deleted app: ${appName}`);
  }
}
export async function listApps(dongle, targetId, rootPrivateKey = null) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.listApp();
}
export async function getMemInfo(dongle, targetId, rootPrivateKey = null) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.getMemInfo();
}

/*! Bundled license information:

@noble/secp256k1/index.js:
  (*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

@noble/hashes/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
