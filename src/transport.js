import { CommException, getPossibleErrorCause } from './commException.js';
import { unwrapResponseAPDU, wrapCommandAPDU } from './ledgerWrapper.js';

var LEDGER_VENDOR_ID = 11415;
var HID_PACKET_SIZE = 64;
var CHANNEL_ID = 257;
var DEFAULT_TIMEOUT = 3e4;
export var TransportWebHID = class _TransportWebHID {
  constructor(device, debug = false) {
    this.device = device;
    this.debug = debug;
    this.opened = false;
    this._inputReportPromise = null;
    this._inputReportResolve = null;
  }
  /**
   * Open connection to device
   */
  async open() {
    if (!this.device.opened) {
      await this.device.open();
    }
    this.opened = true;
    this.device.addEventListener("inputreport", (event) => {
      if (this._inputReportResolve) {
        const data = new Uint8Array(event.data.buffer);
        this._inputReportResolve(data);
        this._inputReportResolve = null;
      }
    });
  }
  /**
   * Close connection to device
   */
  async close() {
    if (this.opened && this.device.opened) {
      await this.device.close();
    }
    this.opened = false;
  }
  /**
   * Wait for input report with timeout
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<Uint8Array>}
   */
  async _waitForInputReport(timeout) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._inputReportResolve = null;
        reject(new CommException("Timeout waiting for device response"));
      }, timeout);
      this._inputReportResolve = (data) => {
        clearTimeout(timeoutId);
        resolve(data);
      };
    });
  }
  /**
   * Exchange APDU with device
   * @param {Uint8Array} apdu - APDU command
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<Uint8Array>} - Response data (without SW)
   */
  async exchange(apdu, timeout = DEFAULT_TIMEOUT) {
    if (!this.opened) {
      throw new CommException("Device not opened");
    }
    if (this.debug) {
      console.log("HID => " + bytesToHex(apdu));
    }
    const wrapped = wrapCommandAPDU(CHANNEL_ID, apdu, HID_PACKET_SIZE);
    for (let offset = 0; offset < wrapped.length; offset += HID_PACKET_SIZE) {
      const packet = wrapped.slice(offset, offset + HID_PACKET_SIZE);
      await this.device.sendReport(0, packet);
    }
    let responseBuffer = new Uint8Array(0);
    let response = null;
    while (response === null) {
      const packet = await this._waitForInputReport(timeout);
      const newBuffer = new Uint8Array(responseBuffer.length + packet.length);
      newBuffer.set(responseBuffer);
      newBuffer.set(packet, responseBuffer.length);
      responseBuffer = newBuffer;
      response = unwrapResponseAPDU(CHANNEL_ID, responseBuffer, HID_PACKET_SIZE);
    }
    if (response.length < 2) {
      throw new CommException("Response too short");
    }
    const swOffset = response.length - 2;
    const sw = response[swOffset] << 8 | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    if (this.debug) {
      console.log("HID <= " + bytesToHex(data) + " SW=" + sw.toString(16).padStart(4, "0"));
    }
    if (sw !== 36864 && (sw & 65280) !== 24832 && (sw & 65280) !== 27648) {
      const cause = getPossibleErrorCause(sw);
      throw new CommException(
        `Invalid status ${sw.toString(16).padStart(4, "0")} (${cause})`,
        sw,
        data
      );
    }
    return data;
  }
  /**
   * Exchange APDU with device - raw mode (like Python's comm.exchange)
   * Returns {data, sw} without throwing on non-9000 status words.
   * This matches Python ledgerblue behavior where the caller checks SW.
   * @param {Uint8Array} apdu - APDU command
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<{data: Uint8Array, sw: number}>} - Response data and status word
   */
  async exchangeRaw(apdu, timeout = DEFAULT_TIMEOUT) {
    if (!this.opened) {
      throw new CommException("Device not opened");
    }
    if (this.debug) {
      console.log("HID => " + bytesToHex(apdu));
    }
    const wrapped = wrapCommandAPDU(CHANNEL_ID, apdu, HID_PACKET_SIZE);
    for (let offset = 0; offset < wrapped.length; offset += HID_PACKET_SIZE) {
      const packet = wrapped.slice(offset, offset + HID_PACKET_SIZE);
      await this.device.sendReport(0, packet);
    }
    let responseBuffer = new Uint8Array(0);
    let response = null;
    while (response === null) {
      const packet = await this._waitForInputReport(timeout);
      const newBuffer = new Uint8Array(responseBuffer.length + packet.length);
      newBuffer.set(responseBuffer);
      newBuffer.set(packet, responseBuffer.length);
      responseBuffer = newBuffer;
      response = unwrapResponseAPDU(CHANNEL_ID, responseBuffer, HID_PACKET_SIZE);
    }
    if (response.length < 2) {
      throw new CommException("Response too short");
    }
    const swOffset = response.length - 2;
    const sw = response[swOffset] << 8 | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    if (this.debug) {
      console.log("HID <= " + bytesToHex(data) + " SW=" + sw.toString(16).padStart(4, "0"));
    }
    return { data, sw };
  }
  /**
   * Get maximum APDU data size
   * @returns {number}
   */
  apduMaxDataSize() {
    return 255;
  }
  /**
   * Request device from user
   * @param {boolean} debug - Enable debug logging
   * @returns {Promise<TransportWebHID>}
   */
  static async request(debug = false) {
    if (!navigator.hid) {
      throw new CommException("WebHID not supported in this browser");
    }
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: LEDGER_VENDOR_ID }]
    });
    if (devices.length === 0) {
      throw new CommException("No Ledger device selected");
    }
    let selectedDevice = devices[0];
    for (const device of devices) {
      if (device.collections) {
        for (const collection of device.collections) {
          if (collection.usagePage === 65440) {
            selectedDevice = device;
            break;
          }
        }
      }
    }
    const transport = new _TransportWebHID(selectedDevice, debug);
    await transport.open();
    return transport;
  }
  /**
   * Get already paired devices
   * @param {boolean} debug - Enable debug logging
   * @returns {Promise<TransportWebHID[]>}
   */
  static async getDevices(debug = false) {
    if (!navigator.hid) {
      throw new CommException("WebHID not supported in this browser");
    }
    const devices = await navigator.hid.getDevices();
    const ledgerDevices = devices.filter((d) => d.vendorId === LEDGER_VENDOR_ID);
    return ledgerDevices.map((device) => new _TransportWebHID(device, debug));
  }
  /**
   * Open first available device
   * @param {boolean} debug - Enable debug logging
   * @returns {Promise<TransportWebHID>}
   */
  static async openFirst(debug = false) {
    const transports = await _TransportWebHID.getDevices(debug);
    if (transports.length === 0) {
      return _TransportWebHID.request(debug);
    }
    const transport = transports[0];
    await transport.open();
    return transport;
  }
};
export var TransportMock = class {
  constructor(responseHandler = null, debug = false) {
    this.debug = debug;
    this.opened = true;
    this.responseHandler = responseHandler;
    this.exchanges = [];
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async exchange(apdu, timeout = DEFAULT_TIMEOUT) {
    if (this.debug) {
      console.log("MOCK => " + bytesToHex(apdu));
    }
    this.exchanges.push(new Uint8Array(apdu));
    let response;
    if (this.responseHandler) {
      response = await this.responseHandler(apdu);
    } else {
      response = new Uint8Array([144, 0]);
    }
    if (this.debug) {
      console.log("MOCK <= " + bytesToHex(response));
    }
    if (response.length < 2) {
      throw new CommException("Response too short");
    }
    const swOffset = response.length - 2;
    const sw = response[swOffset] << 8 | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    if (sw !== 36864 && (sw & 65280) !== 24832 && (sw & 65280) !== 27648) {
      const cause = getPossibleErrorCause(sw);
      throw new CommException(
        `Invalid status ${sw.toString(16).padStart(4, "0")} (${cause})`,
        sw,
        data
      );
    }
    return data;
  }
  async exchangeRaw(apdu, timeout = DEFAULT_TIMEOUT) {
    if (this.debug) {
      console.log("MOCK => " + bytesToHex(apdu));
    }
    this.exchanges.push(new Uint8Array(apdu));
    let response;
    if (this.responseHandler) {
      response = await this.responseHandler(apdu);
    } else {
      response = new Uint8Array([144, 0]);
    }
    if (this.debug) {
      console.log("MOCK <= " + bytesToHex(response));
    }
    if (response.length < 2) {
      throw new CommException("Response too short");
    }
    const swOffset = response.length - 2;
    const sw = response[swOffset] << 8 | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    return { data, sw };
  }
  apduMaxDataSize() {
    return 255;
  }
};
export function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
