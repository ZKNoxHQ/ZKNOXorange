// Device identification from the dashboard (BOLOS home screen).
//
// GET_VERSION, CLA E0 INS 01, is answered by the dashboard only:
//
//   targetId(4 BE) || len || seVersion || len || flags || len || mcuVersion [|| len || mcuBlVersion]
//
// Inside an app the same APDU is refused (6E00 / 6D00), which is the signal
// that the user has to quit the app first: the loader (SCP + load) is a
// dashboard service anyway.

import { TARGET_IDS } from './loadApp.js';

export const TARGET_NAMES = Object.fromEntries(
  Object.entries(TARGET_IDS).map(([name, id]) => [id, name])
);

function readLv(buf, pos) {
  const len = buf[pos];
  return { value: buf.slice(pos + 1, pos + 1 + len), next: pos + 1 + len };
}

export async function getDeviceInfo(dongle) {
  const apdu = new Uint8Array([0xe0, 0x01, 0x00, 0x00, 0x00]);
  let data;
  try {
    data = await dongle.exchange(apdu);
  } catch (e) {
    throw new Error(`GET_VERSION refused (${e.message}): quit the running app and stay on the dashboard`);
  }
  if (data.length < 5) {
    throw new Error('GET_VERSION: response too short, is the device on the dashboard?');
  }
  const targetId = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  const dec = new TextDecoder();
  let pos = 4;
  const se = readLv(data, pos); pos = se.next;
  let flags = new Uint8Array(0);
  let mcu = new Uint8Array(0);
  if (pos < data.length) { const f = readLv(data, pos); flags = f.value; pos = f.next; }
  if (pos < data.length) { const m = readLv(data, pos); mcu = m.value; pos = m.next; }
  return {
    targetId,
    targetName: TARGET_NAMES[targetId] || null,
    seVersion: dec.decode(se.value),
    mcuVersion: dec.decode(mcu),
    flags,
  };
}
