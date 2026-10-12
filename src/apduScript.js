// Replay of a ledgerblue offline load script (`app.apdu`, produced by the
// Ledger SDK with `loadApp --offline`).
//
// The script is the exact loader conversation `make load` would have had,
// one plaintext APDU per line, before the secure channel is applied:
//
//   e0 00 00 00 Lc  0c <len> <name>        delete app by name
//   e0 00 00 00 Lc  0b <createApp params>  code/data/install-params sizes, api_level, flags
//   e0 00 00 00 Lc  05 <addr(4)>           select segment
//   e0 00 00 00 Lc  06 <off(2)> <chunk>    load (208-byte chunks, SCP-sized)
//   e0 00 00 00 Lc  07                     flush
//   e0 00 00 00 Lc  08 <off(4)><len(4)><crc(2)>
//   e0 00 00 00 Lc  09                     commit
//
// Everything target-specific (targetId, api_level, sizes read from the ELF)
// is already baked in by the build, so nothing has to be parsed from
// app.hex / app.map / the Makefile. The sideloader only has to open the SCP
// channel and wrap each payload: HexLoader.exchange() does exactly that, and
// the 208-byte chunks the SDK emits are the ones HexLoader.load() would
// produce itself (240 - 3 header - 1 pad - 14 MAC, rounded to 16).

import { HexLoader } from './hexLoader.js';
import { getDeployedSecretV2 } from './deployed.js';
import { PrivateKey, hexToBytes, bytesToHex } from './ecWrapper.js';
import { getDeviceInfo } from './device.js';

const CMD_DELETE_APP = 0x0c;
const CMD_CREATE_APP = 0x0b;
const CMD_LOAD = 0x06;

// Parses the script into [{ cla, ins, p1, p2, data }]. Throws on anything
// that is not a loader APDU (CLA 0xE0, INS/P1/P2 = 0, Lc consistent).
export function parseApduScript(text) {
  const apdus = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!/^[0-9a-fA-F]+$/.test(line) || line.length % 2 !== 0) {
      throw new Error(`app.apdu line ${i + 1}: not hex`);
    }
    const bytes = hexToBytes(line);
    if (bytes.length < 5) throw new Error(`app.apdu line ${i + 1}: too short`);
    const [cla, ins, p1, p2, lc] = bytes;
    const data = bytes.slice(5);
    if (cla !== 0xe0 || ins !== 0x00 || p1 !== 0x00 || p2 !== 0x00) {
      throw new Error(`app.apdu line ${i + 1}: not a loader APDU (${bytesToHex(bytes.slice(0, 4))})`);
    }
    if (lc !== data.length) {
      throw new Error(`app.apdu line ${i + 1}: Lc=${lc} but ${data.length} data bytes`);
    }
    apdus.push({ cla, ins, p1, p2, data });
  }
  if (apdus.length === 0) throw new Error('app.apdu: empty script');
  return apdus;
}

// Summary used by the UI before replaying: app name from the delete command,
// number of load chunks, total code bytes.
export function describeApduScript(apdus) {
  let appName = null;
  let loadChunks = 0;
  let loadBytes = 0;
  let hasCreate = false;
  for (const { data } of apdus) {
    switch (data[0]) {
      case CMD_DELETE_APP:
        appName = new TextDecoder().decode(data.slice(2, 2 + data[1]));
        break;
      case CMD_CREATE_APP:
        hasCreate = true;
        break;
      case CMD_LOAD:
        loadChunks++;
        loadBytes += data.length - 3;
        break;
      default:
        break;
    }
  }
  if (!hasCreate) throw new Error('app.apdu: no createApp command, not a load script');
  return { appName, loadChunks, loadBytes, apdus: apdus.length };
}

// Replays the script over a fresh SCP channel.
//
// options:
//   targetId        from the connected device; read via GET_VERSION when omitted
//   rootPrivateKey  hex or bytes; random ephemeral key when null (same policy as loadApp)
//   delete          replay the leading deleteApp (default true; its failure is ignored)
//   onProgress      ({ index, total, cmd }) => void
//   debug           console logging
export async function replayApduScript(dongle, text, options = {}) {
  let {
    targetId = null,
    rootPrivateKey: rootPrivateKeyOption = null,
    delete: deleteFirst = true,
    onProgress = null,
    debug = false,
  } = options;
  if (targetId === null) targetId = (await getDeviceInfo(dongle)).targetId;

  const apdus = parseApduScript(text);
  const info = describeApduScript(apdus);

  let rootPrivateKey;
  if (rootPrivateKeyOption === null) {
    rootPrivateKey = new PrivateKey().getPrivateKeyBytes();
  } else {
    rootPrivateKey = typeof rootPrivateKeyOption === 'string' ? hexToBytes(rootPrivateKeyOption) : rootPrivateKeyOption;
  }

  if (debug) console.log(`replayApduScript: ${info.appName} ${info.apdus} APDUs, ${info.loadBytes}B in ${info.loadChunks} chunks`);
  const secret = await getDeployedSecretV2(dongle, rootPrivateKey, targetId);
  const loader = new HexLoader(dongle, 0xe0, true, secret, true, null);

  for (let i = 0; i < apdus.length; i++) {
    const { cla, ins, p1, p2, data } = apdus[i];
    const cmd = data[0];
    if (onProgress) onProgress({ index: i, total: apdus.length, cmd });
    if (cmd === CMD_DELETE_APP) {
      if (!deleteFirst) continue;
      try {
        await loader.exchange(cla, ins, p1, p2, data);
      } catch (e) {
        if (debug) console.log(`delete failed (may not exist): ${e.message}`);
      }
      continue;
    }
    await loader.exchange(cla, ins, p1, p2, data);
  }
  return info;
}
