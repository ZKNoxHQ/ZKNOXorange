// Web Bluetooth transport for Ledger devices (Nano X, Stax, Flex).
//
// Same surface as TransportWebHID: open(), close(), exchange(apdu) which
// throws on a bad status word, exchangeRaw(apdu) which returns { data, sw },
// and static request(). Mirrors @ledgerhq/hw-transport-web-ble:
//
//   GATT service per model, three characteristics: notify (device -> host),
//   write (with response) and writeCmd (without response, preferred).
//   Frame: tag(1) || seq(2 BE) || [len(2 BE) on seq 0] || payload, tag 0x05
//   for APDUs. MTU is negotiated with a tag 0x08 frame: the device answers
//   0x08 00 00 00 00 <mtu>, usable frame size = mtu (ledgerjs adds 3 to the
//   byte and that is the ATT MTU; the frame payload byte is what we use).
//
// Browser support: Chrome/Edge (navigator.bluetooth), secure context
// (https or localhost). On Linux, BlueZ must be running and the adapter up.

import { CommException, getPossibleErrorCause } from './commException.js';

const DEFAULT_TIMEOUT = 30000;
const TAG_APDU = 0x05;
const TAG_MTU = 0x08;

// uuid base: 13d63400-2c97-XXXX-000Y-4c6564676572 ("Ledger")
function ledgerUuid(model, idx) {
  return `13d63400-2c97-${model}-000${idx}-4c6564676572`;
}

export const BLE_MODELS = [
  { name: 'NANO_X', service: ledgerUuid('0004', 0), notify: ledgerUuid('0004', 1), write: ledgerUuid('0004', 2), writeCmd: ledgerUuid('0004', 3) },
  { name: 'STAX',   service: ledgerUuid('6004', 0), notify: ledgerUuid('6004', 1), write: ledgerUuid('6004', 2), writeCmd: ledgerUuid('6004', 3) },
  { name: 'FLEX',   service: ledgerUuid('3004', 0), notify: ledgerUuid('3004', 1), write: ledgerUuid('3004', 2), writeCmd: ledgerUuid('3004', 3) },
];

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class TransportWebBLE {
  constructor(device, debug = false) {
    this.device = device;
    this.debug = debug;
    this.opened = false;
    this.model = null;
    this.server = null;
    this.notifyChar = null;
    this.writeChar = null;
    this.writeCmdChar = null;
    this.mtu = 20;
    this._queue = [];      // notifications not yet consumed
    this._waiter = null;   // { resolve, reject, timeoutId }
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async open() {
    if (this.opened) return;
    this.server = await this.device.gatt.connect();
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

    let service = null;
    for (const m of BLE_MODELS) {
      try {
        service = await this.server.getPrimaryService(m.service);
        this.model = m;
        break;
      } catch (e) { /* not this model */ }
    }
    if (!service) throw new CommException('No Ledger BLE service found on this device');

    this.notifyChar = await service.getCharacteristic(this.model.notify);
    this.writeChar = await service.getCharacteristic(this.model.write);
    try {
      this.writeCmdChar = await service.getCharacteristic(this.model.writeCmd);
    } catch (e) {
      this.writeCmdChar = null;
    }

    this.notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.notifyChar.startNotifications();
    this.opened = true;

    await this._inferMtu();
    if (this.debug) console.log(`BLE: ${this.model.name} connected, mtu=${this.mtu}`);
  }

  async close() {
    if (!this.opened) return;
    this.opened = false;
    try { this.notifyChar.removeEventListener('characteristicvaluechanged', this._onNotify); } catch (e) { /* ignore */ }
    try { await this.notifyChar.stopNotifications(); } catch (e) { /* ignore */ }
    this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }

  _onDisconnect() {
    this.opened = false;
    if (this._waiter) {
      const w = this._waiter; this._waiter = null;
      clearTimeout(w.timeoutId);
      w.reject(new CommException('BLE device disconnected'));
    }
  }

  _onNotify(event) {
    const value = new Uint8Array(event.target.value.buffer);
    if (this.debug) console.log('BLE <= frame ' + bytesToHex(value));
    if (this._waiter) {
      const w = this._waiter; this._waiter = null;
      clearTimeout(w.timeoutId);
      w.resolve(value);
    } else {
      this._queue.push(value);
    }
  }

  _nextFrame(timeout) {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._waiter = null;
        reject(new CommException('Timeout waiting for BLE notification'));
      }, timeout);
      this._waiter = { resolve, reject, timeoutId };
    });
  }

  async _writeFrame(frame) {
    if (this.debug) console.log('BLE => frame ' + bytesToHex(frame));
    if (this.writeCmdChar) {
      await this.writeCmdChar.writeValueWithoutResponse(frame);
    } else {
      await this.writeChar.writeValueWithResponse(frame);
    }
  }

  async _inferMtu() {
    this._queue.length = 0;
    await this._writeFrame(new Uint8Array([TAG_MTU, 0, 0, 0, 0]));
    const frame = await this._nextFrame(5000);
    if (frame[0] !== TAG_MTU || frame.length < 6) {
      throw new CommException('Unexpected MTU response ' + bytesToHex(frame));
    }
    const mtu = frame[5];
    if (mtu > this.mtu) this.mtu = mtu;
  }

  async _sendApdu(apdu) {
    let offset = 0;
    let seq = 0;
    while (offset < apdu.length || seq === 0) {
      const header = seq === 0 ? 5 : 3;
      const chunkLen = Math.min(this.mtu - header, apdu.length - offset);
      const frame = new Uint8Array(header + chunkLen);
      frame[0] = TAG_APDU;
      frame[1] = (seq >> 8) & 0xff;
      frame[2] = seq & 0xff;
      if (seq === 0) {
        frame[3] = (apdu.length >> 8) & 0xff;
        frame[4] = apdu.length & 0xff;
      }
      frame.set(apdu.slice(offset, offset + chunkLen), header);
      await this._writeFrame(frame);
      offset += chunkLen;
      seq++;
    }
  }

  async _receiveApdu(timeout) {
    let expected = -1;
    let received = new Uint8Array(0);
    let seq = 0;
    while (expected < 0 || received.length < expected) {
      const frame = await this._nextFrame(timeout);
      if (frame[0] !== TAG_APDU) {
        // keep-alive or foreign tag: ignore
        continue;
      }
      const idx = (frame[1] << 8) | frame[2];
      if (idx !== seq) throw new CommException(`BLE sequence error: got ${idx}, expected ${seq}`);
      let payload;
      if (idx === 0) {
        expected = (frame[3] << 8) | frame[4];
        payload = frame.slice(5);
      } else {
        payload = frame.slice(3);
      }
      const merged = new Uint8Array(received.length + payload.length);
      merged.set(received);
      merged.set(payload, received.length);
      received = merged;
      seq++;
    }
    return received.slice(0, expected);
  }

  async exchangeRaw(apdu, timeout = DEFAULT_TIMEOUT) {
    if (!this.opened) throw new CommException('Device not opened');
    if (this.debug) console.log('BLE => ' + bytesToHex(apdu));
    this._queue.length = 0;
    await this._sendApdu(apdu);
    const response = await this._receiveApdu(timeout);
    if (response.length < 2) throw new CommException('Response too short');
    const swOffset = response.length - 2;
    const sw = (response[swOffset] << 8) | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    if (this.debug) console.log('BLE <= ' + bytesToHex(data) + ' SW=' + sw.toString(16).padStart(4, '0'));
    return { data, sw };
  }

  async exchange(apdu, timeout = DEFAULT_TIMEOUT) {
    const { data, sw } = await this.exchangeRaw(apdu, timeout);
    if (sw !== 0x9000 && (sw & 0xff00) !== 0x6100 && (sw & 0xff00) !== 0x6c00) {
      throw new CommException(`Invalid status ${sw.toString(16).padStart(4, '0')} (${getPossibleErrorCause(sw)})`, sw, data);
    }
    return data;
  }

  apduMaxDataSize() {
    return 255;
  }

  // Opens the browser's Bluetooth chooser filtered on Ledger services.
  static async request(debug = false) {
    if (!TransportWebBLE.isSupported()) {
      throw new CommException('Web Bluetooth not supported in this browser (Chrome/Edge, https or localhost)');
    }
    const services = BLE_MODELS.map((m) => m.service);
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: services.map((s) => ({ services: [s] })),
        optionalServices: services,
      });
    } catch (e) {
      throw new CommException('No Ledger selected in the Bluetooth chooser (' + e.message + ')');
    }
    const transport = new TransportWebBLE(device, debug);
    await transport.open();
    return transport;
  }
}
