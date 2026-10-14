// src/commException.js
var CommException = class extends Error {
  constructor(message, sw = 28416, data = null) {
    super(message);
    this.name = "CommException";
    this.sw = sw;
    this.data = data;
  }
  toString() {
    return `Exception: ${this.message}`;
  }
};
function getPossibleErrorCause(sw) {
  const causeMap = {
    27010: "Have you uninstalled the existing CA with resetCustomCA first?",
    27013: "Condition of use not satisfied (denied by the user?)",
    27268: "Not enough space?",
    27269: "Not enough space?",
    27267: "Maybe this app requires a library to be installed first?",
    25732: "Are you using the correct targetId?",
    27904: "Unexpected state of device: verify that the right application is opened?",
    28160: "Unexpected state of device: verify that the right application is opened?",
    28161: "CLA not supported - wrong APDU format after SCP?",
    21781: "Did you unlock the device?",
    26644: "Unexpected target device: verify that you are using the right device?",
    20767: "OS version incompatible with SDK used to build the app",
    20768: "Sideload is not supported on Nano X",
    25873: "Device is not in Recovery Mode - boot while holding button",
    25874: "Device locked or not in right state",
    22279: "SCP certificate validation failed - check custom CA installation",
    26115: "SCP mutual authentication failed - certificate chain rejected",
    21012: "Custom CA setup rejected - device may not be in onboarding state",
    26133: "SCP encryption error - key mismatch or corrupted data"
  };
  return causeMap[sw] || `Unknown reason (0x${sw.toString(16)})`;
}

// src/ledgerWrapper.js
function wrapCommandAPDU(channel, command, packetSize, ble = false) {
  if (packetSize < 3) {
    throw new CommException(
      "Can't handle Ledger framing with less than 3 bytes for the report"
    );
  }
  let sequenceIdx = 0;
  let offset = 0;
  const extraHeaderSize = ble ? 0 : 2;
  let result = [];
  if (!ble) {
    result.push(channel >> 8 & 255);
    result.push(channel & 255);
  }
  result.push(5);
  result.push(sequenceIdx >> 8 & 255);
  result.push(sequenceIdx & 255);
  result.push(command.length >> 8 & 255);
  result.push(command.length & 255);
  sequenceIdx++;
  let blockSize = Math.min(
    command.length,
    packetSize - 5 - extraHeaderSize
  );
  for (let i = 0; i < blockSize; i++) {
    result.push(command[offset + i]);
  }
  offset += blockSize;
  while (offset < command.length) {
    if (!ble) {
      result.push(channel >> 8 & 255);
      result.push(channel & 255);
    }
    result.push(5);
    result.push(sequenceIdx >> 8 & 255);
    result.push(sequenceIdx & 255);
    sequenceIdx++;
    blockSize = Math.min(
      command.length - offset,
      packetSize - 3 - extraHeaderSize
    );
    for (let i = 0; i < blockSize; i++) {
      result.push(command[offset + i]);
    }
    offset += blockSize;
  }
  if (!ble) {
    while (result.length % packetSize !== 0) {
      result.push(0);
    }
  }
  return new Uint8Array(result);
}
function unwrapResponseAPDU(channel, data, packetSize, ble = false) {
  let sequenceIdx = 0;
  let offset = 0;
  const extraHeaderSize = ble ? 0 : 2;
  if (!data || data.length < 5 + extraHeaderSize + 5) {
    return null;
  }
  if (!ble) {
    const receivedChannel = data[offset] << 8 | data[offset + 1];
    if (receivedChannel !== channel) {
      throw new CommException("Invalid channel");
    }
    offset += 2;
  }
  if (data[offset] !== 5) {
    throw new CommException("Invalid tag");
  }
  offset++;
  const receivedSeq = data[offset] << 8 | data[offset + 1];
  if (receivedSeq !== sequenceIdx) {
    throw new CommException("Invalid sequence");
  }
  offset += 2;
  const responseLength = data[offset] << 8 | data[offset + 1];
  offset += 2;
  if (data.length < 5 + extraHeaderSize + responseLength) {
    return null;
  }
  let blockSize = Math.min(
    responseLength,
    packetSize - 5 - extraHeaderSize
  );
  let result = [];
  for (let i = 0; i < blockSize; i++) {
    result.push(data[offset + i]);
  }
  offset += blockSize;
  while (result.length < responseLength) {
    sequenceIdx++;
    if (offset >= data.length) {
      return null;
    }
    if (!ble) {
      const receivedChannel = data[offset] << 8 | data[offset + 1];
      if (receivedChannel !== channel) {
        throw new CommException("Invalid channel");
      }
      offset += 2;
    }
    if (data[offset] !== 5) {
      throw new CommException("Invalid tag");
    }
    offset++;
    const receivedSeq2 = data[offset] << 8 | data[offset + 1];
    if (receivedSeq2 !== sequenceIdx) {
      throw new CommException("Invalid sequence");
    }
    offset += 2;
    blockSize = Math.min(
      responseLength - result.length,
      packetSize - 3 - extraHeaderSize
    );
    for (let i = 0; i < blockSize; i++) {
      result.push(data[offset + i]);
    }
    offset += blockSize;
  }
  return new Uint8Array(result);
}

// src/transport.js
var LEDGER_VENDOR_ID = 11415;
var HID_PACKET_SIZE = 64;
var CHANNEL_ID = 257;
var DEFAULT_TIMEOUT = 3e4;
var TransportWebHID = class _TransportWebHID {
  constructor(device, debug = false) {
    this.device = device;
    this.debug = debug;
    this.opened = false;
    this._inputReportPromise = null;
    this._inputReportResolve = null;
    this._inputReportReject = null;
    this._onDisconnect = null;
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
    if (navigator.hid && !this._onDisconnect) {
      this._onDisconnect = (event) => {
        if (event.device !== this.device) return;
        this.opened = false;
        if (this._inputReportReject) this._inputReportReject(new CommException("Device disconnected"));
      };
      navigator.hid.addEventListener("disconnect", this._onDisconnect);
    }
  }
  /**
   * Close connection to device
   */
  async close() {
    if (navigator.hid && this._onDisconnect) {
      navigator.hid.removeEventListener("disconnect", this._onDisconnect);
      this._onDisconnect = null;
    }
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
        this._inputReportReject = null;
        reject(new CommException("Timeout waiting for device response"));
      }, timeout);
      this._inputReportResolve = (data) => {
        clearTimeout(timeoutId);
        this._inputReportReject = null;
        resolve(data);
      };
      this._inputReportReject = (err2) => {
        clearTimeout(timeoutId);
        this._inputReportResolve = null;
        this._inputReportReject = null;
        reject(err2);
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
      try {
        await this.device.sendReport(0, packet);
      } catch (e) {
        this.opened = false;
        throw new CommException(`Device disconnected (failed to write: ${e.message})`);
      }
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
      try {
        await this.device.sendReport(0, packet);
      } catch (e) {
        this.opened = false;
        throw new CommException(`Device disconnected (failed to write: ${e.message})`);
      }
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
var TransportMock = class {
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
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// node_modules/@noble/secp256k1/index.js
var secp256k1_CURVE = {
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
  n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  h: 1n,
  a: 0n,
  b: 7n,
  Gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  Gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
};
var { p: P, n: N, Gx, Gy, b: _b } = secp256k1_CURVE;
var L = 32;
var L2 = 64;
var lengths = {
  publicKey: L + 1,
  publicKeyUncompressed: L2 + 1,
  signature: L2,
  seed: L + L / 2
};
var captureTrace = (...args) => {
  if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(...args);
  }
};
var err = (message = "") => {
  const e = new Error(message);
  captureTrace(e, err);
  throw e;
};
var isBig = (n) => typeof n === "bigint";
var isStr = (s) => typeof s === "string";
var isBytes = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
var abytes = (value, length, title = "") => {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    err(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
};
var u8n = (len) => new Uint8Array(len);
var padh = (n, pad) => n.toString(16).padStart(pad, "0");
var bytesToHex2 = (b) => Array.from(abytes(b)).map((e) => padh(e, 2)).join("");
var C = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
var _ch = (ch) => {
  if (ch >= C._0 && ch <= C._9)
    return ch - C._0;
  if (ch >= C.A && ch <= C.F)
    return ch - (C.A - 10);
  if (ch >= C.a && ch <= C.f)
    return ch - (C.a - 10);
  return;
};
var hexToBytes = (hex) => {
  const e = "hex invalid";
  if (!isStr(hex))
    return err(e);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    return err(e);
  const array = u8n(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = _ch(hex.charCodeAt(hi));
    const n2 = _ch(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0)
      return err(e);
    array[ai] = n1 * 16 + n2;
  }
  return array;
};
var cr = () => globalThis?.crypto;
var subtle = () => cr()?.subtle ?? err("crypto.subtle must be defined, consider polyfill");
var concatBytes = (...arrs) => {
  const r = u8n(arrs.reduce((sum, a) => sum + abytes(a).length, 0));
  let pad = 0;
  arrs.forEach((a) => {
    r.set(a, pad);
    pad += a.length;
  });
  return r;
};
var randomBytes = (len = L) => {
  const c = cr();
  return c.getRandomValues(u8n(len));
};
var big = BigInt;
var arange = (n, min, max, msg = "bad number: out of range") => isBig(n) && min <= n && n < max ? n : err(msg);
var M = (a, b = P) => {
  const r = a % b;
  return r >= 0n ? r : b + r;
};
var modN = (a) => M(a, N);
var invert = (num, md) => {
  if (num === 0n || md <= 0n)
    err("no inverse n=" + num + " mod=" + md);
  let a = M(num, md), b = md, x = 0n, y = 1n, u = 1n, v = 0n;
  while (a !== 0n) {
    const q = b / a, r = b % a;
    const m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  return b === 1n ? M(x, md) : err("no inverse");
};
var callHash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function")
    err("hashes." + name + " not set");
  return fn;
};
var apoint = (p) => p instanceof Point ? p : err("Point expected");
var koblitz = (x) => M(M(x * x) * x + _b);
var FpIsValid = (n) => arange(n, 0n, P);
var FpIsValidNot0 = (n) => arange(n, 1n, P);
var FnIsValidNot0 = (n) => arange(n, 1n, N);
var isEven = (y) => (y & 1n) === 0n;
var u8of = (n) => Uint8Array.of(n);
var getPrefix = (y) => u8of(isEven(y) ? 2 : 3);
var lift_x = (x) => {
  const c = koblitz(FpIsValidNot0(x));
  let r = 1n;
  for (let num = c, e = (P + 1n) / 4n; e > 0n; e >>= 1n) {
    if (e & 1n)
      r = r * num % P;
    num = num * num % P;
  }
  return M(r * r) === c ? r : err("sqrt invalid");
};
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  constructor(X, Y, Z) {
    this.X = FpIsValid(X);
    this.Y = FpIsValidNot0(Y);
    this.Z = FpIsValid(Z);
    Object.freeze(this);
  }
  static CURVE() {
    return secp256k1_CURVE;
  }
  /** Create 3d xyz point from 2d xy. (0, 0) => (0, 1, 0), not (0, 0, 1) */
  static fromAffine(ap) {
    const { x, y } = ap;
    return x === 0n && y === 0n ? I : new _Point(x, y, 1n);
  }
  /** Convert Uint8Array or hex string to Point. */
  static fromBytes(bytes) {
    abytes(bytes);
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    let p = void 0;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    const x = sliceBytesNumBE(tail, 0, L);
    if (length === comp && (head === 2 || head === 3)) {
      let y = lift_x(x);
      const evenY = isEven(y);
      const evenH = isEven(big(head));
      if (evenH !== evenY)
        y = M(-y);
      p = new _Point(x, y, 1n);
    }
    if (length === uncomp && head === 4)
      p = new _Point(x, sliceBytesNumBE(tail, L, L2), 1n);
    return p ? p.assertValidity() : err("bad point: not on curve");
  }
  static fromHex(hex) {
    return _Point.fromBytes(hexToBytes(hex));
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const X1Z2 = M(X1 * Z2);
    const X2Z1 = M(X2 * Z1);
    const Y1Z2 = M(Y1 * Z2);
    const Y2Z1 = M(Y2 * Z1);
    return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
  }
  is0() {
    return this.equals(I);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(this.X, M(-this.Y), this.Z);
  }
  /** Point doubling: P+P, complete formula. */
  double() {
    return this.add(this);
  }
  /**
   * Point addition: P+Q, complete, exception-free formula
   * (Renes-Costello-Batina, algo 1 of [2015/1060](https://eprint.iacr.org/2015/1060)).
   * Cost: `12M + 0S + 3*a + 3*b3 + 23add`.
   */
  // prettier-ignore
  add(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const a = 0n;
    const b = _b;
    let X3 = 0n, Y3 = 0n, Z3 = 0n;
    const b3 = M(b * 3n);
    let t0 = M(X1 * X2), t1 = M(Y1 * Y2), t2 = M(Z1 * Z2), t3 = M(X1 + Y1);
    let t4 = M(X2 + Y2);
    t3 = M(t3 * t4);
    t4 = M(t0 + t1);
    t3 = M(t3 - t4);
    t4 = M(X1 + Z1);
    let t5 = M(X2 + Z2);
    t4 = M(t4 * t5);
    t5 = M(t0 + t2);
    t4 = M(t4 - t5);
    t5 = M(Y1 + Z1);
    X3 = M(Y2 + Z2);
    t5 = M(t5 * X3);
    X3 = M(t1 + t2);
    t5 = M(t5 - X3);
    Z3 = M(a * t4);
    X3 = M(b3 * t2);
    Z3 = M(X3 + Z3);
    X3 = M(t1 - Z3);
    Z3 = M(t1 + Z3);
    Y3 = M(X3 * Z3);
    t1 = M(t0 + t0);
    t1 = M(t1 + t0);
    t2 = M(a * t2);
    t4 = M(b3 * t4);
    t1 = M(t1 + t2);
    t2 = M(t0 - t2);
    t2 = M(a * t2);
    t4 = M(t4 + t2);
    t0 = M(t1 * t4);
    Y3 = M(Y3 + t0);
    t0 = M(t5 * t4);
    X3 = M(t3 * X3);
    X3 = M(X3 - t0);
    t0 = M(t3 * t1);
    Z3 = M(t5 * Z3);
    Z3 = M(Z3 + t0);
    return new _Point(X3, Y3, Z3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n)
      return I;
    FnIsValidNot0(n);
    if (n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I;
    let f = G;
    for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: x, Y: y, Z: z } = this;
    if (this.equals(I))
      return { x: 0n, y: 0n };
    if (z === 1n)
      return { x, y };
    const iz = invert(z, P);
    if (M(z * iz) !== 1n)
      err("inverse invalid");
    return { x: M(x * iz), y: M(y * iz) };
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const { x, y } = this.toAffine();
    FpIsValidNot0(x);
    FpIsValidNot0(y);
    return M(y * y) === koblitz(x) ? this : err("bad point: not on curve");
  }
  /** Converts point to 33/65-byte Uint8Array. */
  toBytes(isCompressed = true) {
    const { x, y } = this.assertValidity().toAffine();
    const x32b = numTo32b(x);
    if (isCompressed)
      return concatBytes(getPrefix(y), x32b);
    return concatBytes(u8of(4), x32b, numTo32b(y));
  }
  toHex(isCompressed) {
    return bytesToHex2(this.toBytes(isCompressed));
  }
};
var G = new Point(Gx, Gy, 1n);
var I = new Point(0n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var doubleScalarMulUns = (R, u1, u2) => {
  return G.multiply(u1, false).add(R.multiply(u2, false)).assertValidity();
};
var bytesToNumBE = (b) => big("0x" + (bytesToHex2(b) || "0"));
var sliceBytesNumBE = (b, from, to) => bytesToNumBE(b.subarray(from, to));
var B256 = 2n ** 256n;
var numTo32b = (num) => hexToBytes(padh(arange(num, 0n, B256), L2));
var secretKeyToScalar = (secretKey) => {
  const num = bytesToNumBE(abytes(secretKey, L, "secret key"));
  return arange(num, 1n, N, "invalid secret key: outside of range");
};
var highS = (n) => n > N >> 1n;
var getPublicKey = (privKey, isCompressed = true) => {
  return G.multiply(secretKeyToScalar(privKey)).toBytes(isCompressed);
};
var isValidSecretKey = (secretKey) => {
  try {
    return !!secretKeyToScalar(secretKey);
  } catch (error) {
    return false;
  }
};
var isValidPublicKey = (publicKey, isCompressed) => {
  const { publicKey: comp, publicKeyUncompressed } = lengths;
  try {
    const l = publicKey.length;
    if (isCompressed === true && l !== comp)
      return false;
    if (isCompressed === false && l !== publicKeyUncompressed)
      return false;
    return !!Point.fromBytes(publicKey);
  } catch (error) {
    return false;
  }
};
var assertRecoveryBit = (recovery) => {
  if (![0, 1, 2, 3].includes(recovery))
    err("recovery id must be valid and present");
};
var assertSigFormat = (format) => {
  if (format != null && !ALL_SIG.includes(format))
    err(`Signature format must be one of: ${ALL_SIG.join(", ")}`);
  if (format === SIG_DER)
    err('Signature format "der" is not supported: switch to noble-curves');
};
var assertSigLength = (sig, format = SIG_COMPACT) => {
  assertSigFormat(format);
  const SL = lengths.signature;
  const RL = SL + 1;
  let msg = `Signature format "${format}" expects Uint8Array with length `;
  if (format === SIG_COMPACT && sig.length !== SL)
    err(msg + SL);
  if (format === SIG_RECOVERED && sig.length !== RL)
    err(msg + RL);
};
var Signature = class _Signature {
  r;
  s;
  recovery;
  constructor(r, s, recovery) {
    this.r = FnIsValidNot0(r);
    this.s = FnIsValidNot0(s);
    if (recovery != null)
      this.recovery = recovery;
    Object.freeze(this);
  }
  static fromBytes(b, format = SIG_COMPACT) {
    assertSigLength(b, format);
    let rec;
    if (format === SIG_RECOVERED) {
      rec = b[0];
      b = b.subarray(1);
    }
    const r = sliceBytesNumBE(b, 0, L);
    const s = sliceBytesNumBE(b, L, L2);
    return new _Signature(r, s, rec);
  }
  addRecoveryBit(bit) {
    return new _Signature(this.r, this.s, bit);
  }
  hasHighS() {
    return highS(this.s);
  }
  toBytes(format = SIG_COMPACT) {
    const { r, s, recovery } = this;
    const res = concatBytes(numTo32b(r), numTo32b(s));
    if (format === SIG_RECOVERED) {
      assertRecoveryBit(recovery);
      return concatBytes(Uint8Array.of(recovery), res);
    }
    return res;
  }
};
var bits2int = (bytes) => {
  const delta = bytes.length * 8 - 256;
  if (delta > 1024)
    err("msg invalid");
  const num = bytesToNumBE(bytes);
  return delta > 0 ? num >> big(delta) : num;
};
var bits2int_modN = (bytes) => modN(bits2int(abytes(bytes)));
var SIG_COMPACT = "compact";
var SIG_RECOVERED = "recovered";
var SIG_DER = "der";
var ALL_SIG = [SIG_COMPACT, SIG_RECOVERED, SIG_DER];
var defaultSignOpts = {
  lowS: true,
  prehash: true,
  format: SIG_COMPACT,
  extraEntropy: false
};
var _sha = "SHA-256";
var hashes = {
  hmacSha256Async: async (key, message) => {
    const s = subtle();
    const name = "HMAC";
    const k = await s.importKey("raw", key, { name, hash: { name: _sha } }, false, ["sign"]);
    return u8n(await s.sign(name, k, message));
  },
  hmacSha256: void 0,
  sha256Async: async (msg) => u8n(await subtle().digest(_sha, msg)),
  sha256: void 0
};
var prepMsg = (msg, opts, async_) => {
  abytes(msg, void 0, "message");
  if (!opts.prehash)
    return msg;
  return async_ ? hashes.sha256Async(msg) : callHash("sha256")(msg);
};
var NULL = u8n(0);
var byte0 = u8of(0);
var byte1 = u8of(1);
var _maxDrbgIters = 1e3;
var _drbgErr = "drbg: tried max amount of iterations";
var hmacDrbg = (seed, pred) => {
  let v = u8n(L);
  let k = u8n(L);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
  };
  const h = (...b) => callHash("hmacSha256")(k, concatBytes(v, ...b));
  const reseed = (seed2 = NULL) => {
    k = h(byte0, seed2);
    v = h();
    if (seed2.length === 0)
      return;
    k = h(byte1, seed2);
    v = h();
  };
  const gen = () => {
    if (i++ >= _maxDrbgIters)
      err(_drbgErr);
    v = h();
    return v;
  };
  reset();
  reseed(seed);
  let res = void 0;
  while (!(res = pred(gen())))
    reseed();
  reset();
  return res;
};
var _sign = (messageHash, secretKey, opts, hmacDrbg2) => {
  let { lowS, extraEntropy } = opts;
  const int2octets = numTo32b;
  const h1i = bits2int_modN(messageHash);
  const h1o = int2octets(h1i);
  const d = secretKeyToScalar(secretKey);
  const seedArgs = [int2octets(d), h1o];
  if (extraEntropy != null && extraEntropy !== false) {
    const e = extraEntropy === true ? randomBytes(L) : extraEntropy;
    seedArgs.push(abytes(e, void 0, "extraEntropy"));
  }
  const seed = concatBytes(...seedArgs);
  const m = h1i;
  const k2sig = (kBytes) => {
    const k = bits2int(kBytes);
    if (!(1n <= k && k < N))
      return;
    const ik = invert(k, N);
    const q = G.multiply(k).toAffine();
    const r = modN(q.x);
    if (r === 0n)
      return;
    const s = modN(ik * modN(m + r * d));
    if (s === 0n)
      return;
    let recovery = (q.x === r ? 0 : 2) | Number(q.y & 1n);
    let normS = s;
    if (lowS && highS(s)) {
      normS = modN(-s);
      recovery ^= 1;
    }
    const sig = new Signature(r, normS, recovery);
    return sig.toBytes(opts.format);
  };
  return hmacDrbg2(seed, k2sig);
};
var _verify = (sig, messageHash, publicKey, opts = {}) => {
  const { lowS, format } = opts;
  if (sig instanceof Signature)
    err("Signature must be in Uint8Array, use .toBytes()");
  assertSigLength(sig, format);
  abytes(publicKey, void 0, "publicKey");
  try {
    const { r, s } = Signature.fromBytes(sig, format);
    const h = bits2int_modN(messageHash);
    const P2 = Point.fromBytes(publicKey);
    if (lowS && highS(s))
      return false;
    const is = invert(s, N);
    const u1 = modN(h * is);
    const u2 = modN(r * is);
    const R = doubleScalarMulUns(P2, u1, u2).toAffine();
    const v = modN(R.x);
    return v === r;
  } catch (error) {
    return false;
  }
};
var setDefaults = (opts) => {
  const res = {};
  Object.keys(defaultSignOpts).forEach((k) => {
    res[k] = opts[k] ?? defaultSignOpts[k];
  });
  return res;
};
var sign = (message, secretKey, opts = {}) => {
  opts = setDefaults(opts);
  message = prepMsg(message, opts, false);
  return _sign(message, secretKey, opts, hmacDrbg);
};
var verify = (signature, message, publicKey, opts = {}) => {
  opts = setDefaults(opts);
  message = prepMsg(message, opts, false);
  return _verify(signature, message, publicKey, opts);
};
var randomSecretKey = (seed = randomBytes(lengths.seed)) => {
  abytes(seed);
  if (seed.length < lengths.seed || seed.length > 1024)
    err("expected 40-1024b");
  const num = M(bytesToNumBE(seed), N - 1n);
  return numTo32b(num + 1n);
};
var createKeygen = (getPublicKey2) => (seed) => {
  const secretKey = randomSecretKey(seed);
  return { secretKey, publicKey: getPublicKey2(secretKey) };
};
var keygen = createKeygen(getPublicKey);
var etc = {
  hexToBytes,
  bytesToHex: bytesToHex2,
  concatBytes,
  bytesToNumberBE: bytesToNumBE,
  numberToBytesBE: numTo32b,
  mod: M,
  invert,
  // math utilities
  randomBytes,
  secretKeyToScalar,
  abytes
};
var utils = {
  isValidSecretKey,
  isValidPublicKey,
  randomSecretKey
};
var extpubSchnorr = (priv) => {
  const d_ = secretKeyToScalar(priv);
  const p = G.multiply(d_);
  const { x, y } = p.assertValidity().toAffine();
  const d = isEven(y) ? d_ : modN(-d_);
  const px = numTo32b(x);
  return { d, px };
};
var pubSchnorr = (secretKey) => {
  return extpubSchnorr(secretKey).px;
};
var keygenSchnorr = createKeygen(pubSchnorr);
var W = 8;
var scalarBits = 256;
var pwindows = Math.ceil(scalarBits / W) + 1;
var pwindowSize = 2 ** (W - 1);
var precompute = () => {
  const points = [];
  let p = G;
  let b = p;
  for (let w = 0; w < pwindows; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < pwindowSize; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  const pow_2_w = 2 ** W;
  const maxNum = pow_2_w;
  const mask = big(pow_2_w - 1);
  const shiftBy = big(W);
  for (let w = 0; w < pwindows; w++) {
    let wbits = Number(n & mask);
    n >>= shiftBy;
    if (wbits > pwindowSize) {
      wbits -= maxNum;
      n += 1n;
    }
    const off = w * pwindowSize;
    const offF = off;
    const offP = off + Math.abs(wbits) - 1;
    const isEven2 = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isEven2, comp[offF]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n)
    err("invalid wnaf");
  return { p, f };
};

// node_modules/@noble/hashes/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes2(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes2(bytesLength = 32) {
  const cr2 = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr2?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  return cr2.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, false);
  }
  get() {
    const { A, B, C: C2, D, E, F, G: G2, H } = this;
    return [A, B, C2, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B, C2, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C2 | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C: C2, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C2) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C2;
      C2 = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C2 = C2 + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C2, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// node_modules/@noble/hashes/hmac.js
var _HMAC = class {
  oHash;
  iHash;
  blockLen;
  outputLen;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash(hash);
    abytes2(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes2(out, this.outputLen, "output");
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new _HMAC(hash, key);

// src/ecWrapper.js
hashes.sha256 = (msg) => sha256(msg);
hashes.hmacSha256 = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));
var SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
var HALF_ORDER = SECP256K1_ORDER / 2n;
function compactToDER(compact) {
  const r = compact.slice(0, 32);
  const s = compact.slice(32, 64);
  let rStart = 0;
  while (rStart < r.length - 1 && r[rStart] === 0) rStart++;
  let rBytes = r.slice(rStart);
  let sStart = 0;
  while (sStart < s.length - 1 && s[sStart] === 0) sStart++;
  let sBytes = s.slice(sStart);
  if (rBytes[0] & 128) {
    const newR = new Uint8Array(rBytes.length + 1);
    newR[0] = 0;
    newR.set(rBytes, 1);
    rBytes = newR;
  }
  if (sBytes[0] & 128) {
    const newS = new Uint8Array(sBytes.length + 1);
    newS[0] = 0;
    newS.set(sBytes, 1);
    sBytes = newS;
  }
  const totalLen = 2 + rBytes.length + 2 + sBytes.length;
  const der = new Uint8Array(2 + totalLen);
  let offset = 0;
  der[offset++] = 48;
  der[offset++] = totalLen;
  der[offset++] = 2;
  der[offset++] = rBytes.length;
  der.set(rBytes, offset);
  offset += rBytes.length;
  der[offset++] = 2;
  der[offset++] = sBytes.length;
  der.set(sBytes, offset);
  return der;
}
function derToCompact(der) {
  if (der[0] !== 48) throw new Error("Invalid DER: missing SEQUENCE tag");
  let offset = 2;
  if (der[offset] !== 2) throw new Error("Invalid DER: missing INTEGER for r");
  offset++;
  const rLen = der[offset++];
  const rRaw = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 2) throw new Error("Invalid DER: missing INTEGER for s");
  offset++;
  const sLen = der[offset++];
  const sRaw = der.slice(offset, offset + sLen);
  const compact = new Uint8Array(64);
  const rTrim = rRaw[0] === 0 && rRaw.length > 32 ? rRaw.slice(1) : rRaw;
  compact.set(rTrim, 32 - rTrim.length);
  const sTrim = sRaw[0] === 0 && sRaw.length > 32 ? sRaw.slice(1) : sRaw;
  compact.set(sTrim, 64 - sTrim.length);
  return compact;
}
function ensureLowS(compact) {
  const s = bytesToBigInt(compact.slice(32, 64));
  if (s > HALF_ORDER) {
    const newS = SECP256K1_ORDER - s;
    const result = new Uint8Array(64);
    result.set(compact.slice(0, 32));
    result.set(bigIntToBytes(newS, 32), 32);
    return result;
  }
  return compact;
}
var PublicKey = class {
  constructor(pubkey = null, raw = false) {
    if (pubkey === null) {
      this._point = null;
      return;
    }
    if (!raw) throw new Error("Non-raw init not supported");
    this._pubkeyBytes = new Uint8Array(pubkey);
    this._point = Point.fromBytes(pubkey);
  }
  serialize(compressed = true) {
    return this._point.toBytes(compressed);
  }
  /** Deserialize DER sig → compact 64 bytes */
  ecdsaDeserialize(serSig) {
    return derToCompact(serSig);
  }
  /** ECDH: SHA256(compressed_shared_point) - matches Python ledgerblue */
  ecdh(scalar) {
    const sharedPoint = this._point.multiply(bytesToBigInt(scalar));
    return sha256(sharedPoint.toBytes(true));
  }
  tweakAdd(scalar) {
    const tweakPoint = Point.BASE.multiply(bytesToBigInt(scalar));
    this._point = this._point.add(tweakPoint);
  }
  /**
   * Verify ECDSA signature
   * noble v3: verify() hashes internally with SHA256
   *   raw=false → pass raw msg, verify() hashes it (single hash)
   *   raw=true  → msg is already hashed, use {prehashed:true}
   */
  ecdsaVerify(msg, rawSig, raw = false) {
    let compact;
    if (rawSig.length === 64) {
      compact = rawSig;
    } else if (rawSig[0] === 48) {
      compact = derToCompact(rawSig);
    } else {
      compact = rawSig;
    }
    if (raw) {
      return verify(compact, msg, this._point.toBytes(false), { prehashed: true });
    } else {
      return verify(compact, msg, this._point.toBytes(false));
    }
  }
};
var PrivateKey = class {
  constructor(privkey = null) {
    if (privkey === null) {
      this._privateKey = utils.randomSecretKey();
    } else {
      this._privateKey = new Uint8Array(privkey);
    }
    this.pubkey = new PublicKey(getPublicKey(this._privateKey, false), true);
  }
  serialize() {
    return bytesToHex3(this._privateKey);
  }
  getPrivateKeyBytes() {
    return this._privateKey;
  }
  /** Serialize compact sig (64 bytes) → DER with low-S */
  ecdsaSerialize(rawSig) {
    if (rawSig instanceof Uint8Array && rawSig.length === 64) {
      return compactToDER(ensureLowS(rawSig));
    }
    return rawSig;
  }
  /**
   * Sign message with ECDSA
   * noble v3: sign() hashes internally with SHA256
   *   raw=false → pass raw msg to sign(), it hashes once (matches Python/device)
   *   raw=true  → msg is already hashed, use {prehashed:true}
   */
  ecdsaSign(msg, raw = false) {
    if (raw) {
      return sign(msg, this._privateKey, { prehashed: true });
    } else {
      return sign(msg, this._privateKey);
    }
  }
};
function bytesToBigInt(bytes) {
  let result = 0n;
  for (const byte of bytes) result = result << 8n | BigInt(byte);
  return result;
}
function bigIntToBytes(num, length) {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return bytes;
}
function bytesToHex3(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes2(hex) {
  if (hex.length % 2 !== 0) throw new Error("Hex string must have even length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// src/hexParser.js
var IntelHexArea = class {
  constructor(start, data) {
    this.start = start;
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  getStart() {
    return this.start;
  }
  getData() {
    return this.data;
  }
  setData(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
};
function insertAreaSorted(areas, area) {
  let i = 0;
  while (i < areas.length) {
    if (area.start < areas[i].start) {
      break;
    }
    i++;
  }
  areas.splice(i, 0, area);
  return areas;
}
var IntelHexParser = class {
  constructor(hexContent) {
    this.bootAddr = 0;
    this.areas = [];
    const lines = typeof hexContent === "string" ? hexContent.split(/\r?\n/) : hexContent;
    this._parse(lines);
  }
  /**
   * Parse from file content
   * @param {string[]} lines 
   */
  _parse(lines) {
    let lineNumber = 0;
    let startZone = null;
    let startFirst = null;
    let current = null;
    let zoneData = [];
    for (let line of lines) {
      lineNumber++;
      line = line.trim();
      if (line.length === 0) {
        continue;
      }
      if (line[0] !== ":") {
        throw new Error(`Invalid data at line ${lineNumber}`);
      }
      const data = hexToBytes3(line.slice(1));
      const count = data[0];
      const address = (data[1] << 8) + data[2];
      const recordType = data[3];
      if (recordType === 0) {
        if (startZone === null) {
          throw new Error(`Data record but no zone defined at line ${lineNumber}`);
        }
        if (startFirst === null) {
          startFirst = address;
          current = startFirst;
        }
        if (address !== current) {
          this._addArea(new IntelHexArea(
            startZone * 65536 + startFirst,
            new Uint8Array(zoneData)
          ));
          zoneData = [];
          startFirst = address;
          current = address;
        }
        for (let i = 0; i < count; i++) {
          zoneData.push(data[4 + i]);
        }
        current += count;
      }
      if (recordType === 1) {
        if (zoneData.length !== 0) {
          this._addArea(new IntelHexArea(
            startZone * 65536 + startFirst,
            new Uint8Array(zoneData)
          ));
          zoneData = [];
          startZone = null;
          startFirst = null;
          current = null;
        }
      }
      if (recordType === 2) {
        throw new Error("Unsupported record 02");
      }
      if (recordType === 3) {
        throw new Error("Unsupported record 03");
      }
      if (recordType === 4) {
        if (zoneData.length !== 0) {
          this._addArea(new IntelHexArea(
            startZone * 65536 + startFirst,
            new Uint8Array(zoneData)
          ));
          zoneData = [];
          startFirst = null;
          current = null;
        }
        startZone = (data[4] << 8) + data[5];
      }
      if (recordType === 5) {
        this.bootAddr = (data[4] & 255) * 16777216 + (data[5] & 255) * 65536 + (data[6] & 255) * 256 + (data[7] & 255);
      }
    }
    if (zoneData.length !== 0) {
      this._addArea(new IntelHexArea(
        startZone * 65536 + startFirst,
        new Uint8Array(zoneData)
      ));
    }
  }
  _addArea(area) {
    this.areas = insertAreaSorted(this.areas, area);
  }
  getAreas() {
    return this.areas;
  }
  getBootAddr() {
    return this.bootAddr;
  }
  maxAddr() {
    let addr = 0;
    for (const area of this.areas) {
      const end = area.start + area.data.length;
      if (end > addr) {
        addr = end;
      }
    }
    return addr;
  }
  minAddr() {
    let addr = 4294967295;
    for (const area of this.areas) {
      if (area.start < addr) {
        addr = area.start;
      }
    }
    return addr;
  }
};
var IntelHexPrinter = class {
  constructor(parser = null, eol = "\r\n") {
    this.areas = [];
    this.eol = eol;
    this.bootAddr = 0;
    if (parser) {
      for (const area of parser.areas) {
        this.addArea(area.start, area.data);
      }
      this.bootAddr = parser.bootAddr;
    }
  }
  addArea(startAddress, data, insertFirst = false) {
    const area = new IntelHexArea(startAddress, data);
    if (insertFirst) {
      this.areas.unshift(area);
    } else {
      this.areas = insertAreaSorted(this.areas, area);
    }
  }
  getAreas() {
    return this.areas;
  }
  getBootAddr() {
    return this.bootAddr;
  }
  setBootAddr(bootAddr) {
    this.bootAddr = bootAddr | 0;
  }
  maxAddr() {
    let addr = 0;
    for (const area of this.areas) {
      const end = area.start + area.data.length;
      if (end > addr) {
        addr = end;
      }
    }
    return addr;
  }
  minAddr() {
    let addr = 4294967295;
    for (const area of this.areas) {
      if (area.start < addr) {
        addr = area.start;
      }
    }
    return addr;
  }
  _checksum(bin) {
    let cks = 0;
    for (const b of bin) {
      cks += b;
    }
    return -cks & 255;
  }
  _emitBinary(bin) {
    const cks = this._checksum(bin);
    const hexStr = bytesToHex4(bin).toUpperCase();
    const cksStr = cks.toString(16).padStart(2, "0").toUpperCase();
    return `:${hexStr}${cksStr}${this.eol}`;
  }
  /**
   * Generate HEX file content as string
   * @param {number} blockSize 
   * @returns {string}
   */
  generate(blockSize = 32) {
    let output = "";
    for (const area of this.areas) {
      let off = 0;
      let oldoff = area.start + 65536;
      while (off < area.data.length) {
        if ((off & 4294901760) !== (oldoff & 4294901760)) {
          const addrHigh = area.start >> 16 & 65535;
          const record2 = new Uint8Array([
            2,
            0,
            0,
            4,
            addrHigh >> 8 & 255,
            addrHigh & 255
          ]);
          output += this._emitBinary(record2);
        }
        const remaining = area.data.length - off;
        const chunkSize = Math.min(remaining, blockSize);
        const addr = off + (area.start & 65535) & 65535;
        const record = new Uint8Array(4 + chunkSize);
        record[0] = chunkSize;
        record[1] = addr >> 8 & 255;
        record[2] = addr & 255;
        record[3] = 0;
        record.set(area.data.slice(off, off + chunkSize), 4);
        output += this._emitBinary(record);
        oldoff = off;
        off += blockSize;
      }
    }
    const bootAddrBytes = new Uint8Array([
      4,
      0,
      0,
      5,
      this.bootAddr >> 24 & 255,
      this.bootAddr >> 16 & 255,
      this.bootAddr >> 8 & 255,
      this.bootAddr & 255
    ]);
    output += this._emitBinary(bootAddrBytes);
    output += `:00000001FF${this.eol}`;
    return output;
  }
};
function hexToBytes3(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
function bytesToHex4(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/hexLoader.js
var LOAD_SEGMENT_CHUNK_HEADER_LENGTH = 3;
var MIN_PADDING_LENGTH = 1;
var SCP_MAC_LENGTH = 14;
var BOLOS_TAG_APPNAME = 1;
var BOLOS_TAG_APPVERSION = 2;
var BOLOS_TAG_ICON = 3;
var BOLOS_TAG_DERIVEPATH = 4;
var BOLOS_TAG_DEPENDENCY = 6;
var TABLE_CRC16_CCITT = [
  0,
  4129,
  8258,
  12387,
  16516,
  20645,
  24774,
  28903,
  33032,
  37161,
  41290,
  45419,
  49548,
  53677,
  57806,
  61935,
  4657,
  528,
  12915,
  8786,
  21173,
  17044,
  29431,
  25302,
  37689,
  33560,
  45947,
  41818,
  54205,
  50076,
  62463,
  58334,
  9314,
  13379,
  1056,
  5121,
  25830,
  29895,
  17572,
  21637,
  42346,
  46411,
  34088,
  38153,
  58862,
  62927,
  50604,
  54669,
  13907,
  9842,
  5649,
  1584,
  30423,
  26358,
  22165,
  18100,
  46939,
  42874,
  38681,
  34616,
  63455,
  59390,
  55197,
  51132,
  18628,
  22757,
  26758,
  30887,
  2112,
  6241,
  10242,
  14371,
  51660,
  55789,
  59790,
  63919,
  35144,
  39273,
  43274,
  47403,
  23285,
  19156,
  31415,
  27286,
  6769,
  2640,
  14899,
  10770,
  56317,
  52188,
  64447,
  60318,
  39801,
  35672,
  47931,
  43802,
  27814,
  31879,
  19684,
  23749,
  11298,
  15363,
  3168,
  7233,
  60846,
  64911,
  52716,
  56781,
  44330,
  48395,
  36200,
  40265,
  32407,
  28342,
  24277,
  20212,
  15891,
  11826,
  7761,
  3696,
  65439,
  61374,
  57309,
  53244,
  48923,
  44858,
  40793,
  36728,
  37256,
  33193,
  45514,
  41451,
  53516,
  49453,
  61774,
  57711,
  4224,
  161,
  12482,
  8419,
  20484,
  16421,
  28742,
  24679,
  33721,
  37784,
  41979,
  46042,
  49981,
  54044,
  58239,
  62302,
  689,
  4752,
  8947,
  13010,
  16949,
  21012,
  25207,
  29270,
  46570,
  42443,
  38312,
  34185,
  62830,
  58703,
  54572,
  50445,
  13538,
  9411,
  5280,
  1153,
  29798,
  25671,
  21540,
  17413,
  42971,
  47098,
  34713,
  38840,
  59231,
  63358,
  50973,
  55100,
  9939,
  14066,
  1681,
  5808,
  26199,
  30326,
  17941,
  22068,
  55628,
  51565,
  63758,
  59695,
  39368,
  35305,
  47498,
  43435,
  22596,
  18533,
  30726,
  26663,
  6336,
  2273,
  14466,
  10403,
  52093,
  56156,
  60223,
  64286,
  35833,
  39896,
  43963,
  48026,
  19061,
  23124,
  27191,
  31254,
  2801,
  6864,
  10931,
  14994,
  64814,
  60687,
  56684,
  52557,
  48554,
  44427,
  40424,
  36297,
  31782,
  27655,
  23652,
  19525,
  15522,
  11395,
  7392,
  3265,
  61215,
  65342,
  53085,
  57212,
  44955,
  49082,
  36825,
  40952,
  28183,
  32310,
  20053,
  24180,
  11923,
  16050,
  3793,
  7920
];
async function aesCbcEncrypt(key, iv, data) {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % 16 !== 0) {
    throw new Error(`AES-CBC: data length ${data.length} not 16-byte aligned`);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    data
  );
  return new Uint8Array(encrypted, 0, data.length);
}
async function aesCbcDecrypt(key, iv, data) {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % 16 !== 0) {
    throw new Error(`AES-CBC: data length ${data.length} not 16-byte aligned`);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["encrypt", "decrypt"]
  );
  const lastBlock = data.slice(-16);
  const paddingPlain = new Uint8Array(16).fill(16);
  const paddingEncrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: lastBlock },
    cryptoKey,
    paddingPlain
  );
  const paddingBlock = new Uint8Array(paddingEncrypted, 0, 16);
  const dataWithPadding = new Uint8Array(data.length + 16);
  dataWithPadding.set(data);
  dataWithPadding.set(paddingBlock, data.length);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    dataWithPadding
  );
  return new Uint8Array(decrypted).slice(0, data.length);
}
function encodelv(v) {
  const L3 = v.length;
  let header;
  if (L3 < 128) {
    header = new Uint8Array([L3]);
  } else if (L3 < 256) {
    header = new Uint8Array([129, L3]);
  } else if (L3 < 65536) {
    header = new Uint8Array([130, L3 >> 8 & 255, L3 & 255]);
  } else {
    throw new Error("Unimplemented LV encoding");
  }
  const result = new Uint8Array(header.length + v.length);
  result.set(header);
  result.set(v, header.length);
  return result;
}
function encodetlv(t, v) {
  const L3 = v.length;
  let header;
  if (L3 < 128) {
    header = new Uint8Array([t, L3]);
  } else if (L3 < 256) {
    header = new Uint8Array([t, 129, L3]);
  } else if (L3 < 65536) {
    header = new Uint8Array([t, 130, L3 >> 8 & 255, L3 & 255]);
  } else {
    throw new Error("Unimplemented TLV encoding");
  }
  const result = new Uint8Array(header.length + v.length);
  result.set(header);
  result.set(v, header.length);
  return result;
}
var HexLoader = class {
  /**
   * @param {object} card - Transport object with exchange() method
   * @param {number} cla - Command class byte (default 0xE0)
   * @param {boolean} secure - Enable SCP encryption
   * @param {object|Uint8Array} mutauthResult - Result from getDeployedSecretV2
   * @param {boolean} relative - Use relative addressing
   * @param {number|null} cleardataBlockLen - Block length for clear data
   * @param {boolean} scpv3 - Use SCP v3 format (explicit)
   */
  constructor(card, cla = 224, secure = false, mutauthResult = null, relative = true, cleardataBlockLen = null, scpv3 = false) {
    this.card = card;
    this.cla = cla;
    this.secure = secure;
    this.createappParams = null;
    this.createpackParams = null;
    this.scpv3 = scpv3;
    this.maxMtu = 254;
    if (this.card !== null && this.card.apduMaxDataSize) {
      this.maxMtu = Math.min(this.maxMtu, this.card.apduMaxDataSize());
    }
    this.scpVersion = 2;
    this.key = mutauthResult;
    this.iv = new Uint8Array(16);
    this.relative = relative;
    this.cleardataBlockLen = cleardataBlockLen;
    if (this.cleardataBlockLen !== null && this.card !== null && this.card.apduMaxDataSize) {
      this.cleardataBlockLen = Math.min(this.cleardataBlockLen, this.card.apduMaxDataSize());
    }
    if (scpv3) {
      this.scpEncKey = this._scpDeriveKey(mutauthResult, 0);
      this.scpVersion = 3;
      if (this.card !== null && this.card.apduMaxDataSize) {
        this.maxMtu = Math.min(254, this.card.apduMaxDataSize() & 240);
      }
      return;
    }
    if (mutauthResult && typeof mutauthResult === "object" && mutauthResult.ecdh_secret) {
      const ecdhSecret = mutauthResult.ecdh_secret;
      this.scpEncKey = this._scpDeriveKeyV3(ecdhSecret, 0).slice(0, 16);
      this.scpMacKey = this._scpDeriveKeyV3(ecdhSecret, 1).slice(0, 16);
      this.scpEncIv = new Uint8Array(16);
      this.scpMacIv = new Uint8Array(16);
      this.scpVersion = 3;
      this.maxMtu = 254;
      if (this.card !== null && this.card.apduMaxDataSize) {
        this.maxMtu = Math.min(this.maxMtu, this.card.apduMaxDataSize() & 240);
      }
      console.log(`SCP v3: encKey=${bytesToHex5(this.scpEncKey)}, macKey=${bytesToHex5(this.scpMacKey)}, maxMtu=${this.maxMtu}`);
    }
  }
  /**
   * SCP v3 key derivation (SHA256 + EC point method)
   */
  _scpDeriveKeyV3(ecdhSecret, keyIndex) {
    const SECP256K1_ORDER2 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    let retry = 0;
    console.log(`_scpDeriveKeyV3: keyIndex=${keyIndex}, ecdhSecret=${bytesToHex5(ecdhSecret)}`);
    while (true) {
      const data = new Uint8Array(5 + ecdhSecret.length);
      data[0] = keyIndex >> 24 & 255;
      data[1] = keyIndex >> 16 & 255;
      data[2] = keyIndex >> 8 & 255;
      data[3] = keyIndex & 255;
      data[4] = retry;
      data.set(ecdhSecret, 5);
      const di = sha256(data);
      const diBigInt = bytesToBigInt2(di);
      if (diBigInt < SECP256K1_ORDER2) {
        const privkey = new PrivateKey(di);
        const Pi = privkey.pubkey.serialize(false);
        const ki = sha256(Pi);
        console.log(`_scpDeriveKeyV3[${keyIndex}]: di=${bytesToHex5(di)}, Pi[0:8]=${bytesToHex5(Pi.slice(0, 8))}, ki[0:16]=${bytesToHex5(ki.slice(0, 16))}`);
        return ki;
      }
      retry++;
      if (retry > 100) throw new Error("Key derivation failed after 100 retries");
    }
  }
  /**
   * CRC16-CCITT
   */
  crc16(data) {
    let crc = 65535;
    for (let i = 0; i < data.length; i++) {
      const b = (data[i] ^ crc >> 8 & 255) & 255;
      crc = (TABLE_CRC16_CCITT[b] ^ crc << 8) & 65535;
    }
    return crc;
  }
  /**
   * Exchange APDU with SCP encryption
   */
  async exchange(cla, ins, p1, p2, data) {
    const wrappedData = await this.scpWrap(data);
    const apdu = new Uint8Array(5 + wrappedData.length);
    apdu[0] = cla;
    apdu[1] = ins;
    apdu[2] = p1;
    apdu[3] = p2;
    apdu[4] = wrappedData.length;
    apdu.set(wrappedData, 5);
    console.log(`HexLoader.exchange: APDU=${bytesToHex5(apdu)} (${apdu.length}B)`);
    if (this.card === null) {
      console.log("DRY-RUN: " + bytesToHex5(apdu));
      return new Uint8Array(0);
    }
    const response = await this.card.exchange(apdu);
    return this.scpUnwrap(response);
  }
  /**
   * SCP wrap: encrypt + MAC
   * Uses Web Crypto API for AES-CBC operations
   */
  async scpWrap(data) {
    if (!this.secure || data === null || data.length === 0) {
      return data;
    }
    console.log(`scpWrap: plain=${bytesToHex5(data)} (${data.length}B)`);
    let paddedLen = data.length + 1;
    while (paddedLen % 16 !== 0) paddedLen++;
    const paddedData = new Uint8Array(paddedLen);
    paddedData.set(data);
    paddedData[data.length] = 128;
    if (this.scpVersion === 3) {
      const encryptedData = await aesCbcEncrypt(this.scpEncKey, this.scpEncIv, paddedData);
      this.scpEncIv = encryptedData.slice(-16);
      const macData = await aesCbcEncrypt(this.scpMacKey, this.scpMacIv, encryptedData);
      this.scpMacIv = macData.slice(-16);
      const result = new Uint8Array(encryptedData.length + SCP_MAC_LENGTH);
      result.set(encryptedData);
      result.set(this.scpMacIv.slice(-SCP_MAC_LENGTH), encryptedData.length);
      console.log(`scpWrap: enc=${bytesToHex5(encryptedData)}, mac=${bytesToHex5(this.scpMacIv)}, wrapped=${bytesToHex5(result)}`);
      return result;
    } else {
      const encryptedData = await aesCbcEncrypt(this.key, this.iv, paddedData);
      this.iv = encryptedData.slice(-16);
      return encryptedData;
    }
  }
  /**
   * SCP unwrap: verify MAC + decrypt
   */
  async scpUnwrap(data) {
    if (!this.secure || data === null || data.length === 0 || data.length === 2) {
      return data;
    }
    if (this.scpVersion === 3) {
      const encryptedData = data.slice(0, -SCP_MAC_LENGTH);
      const receivedMac = data.slice(-SCP_MAC_LENGTH);
      const macData = await aesCbcEncrypt(this.scpMacKey, this.scpMacIv, encryptedData);
      this.scpMacIv = macData.slice(-16);
      const expectedMac = this.scpMacIv.slice(-SCP_MAC_LENGTH);
      if (!arraysEqual(expectedMac, receivedMac)) {
        throw new Error(`SCP: Invalid MAC (expected=${bytesToHex5(expectedMac)}, got=${bytesToHex5(receivedMac)})`);
      }
      const decryptedData = await aesCbcDecrypt(this.scpEncKey, this.scpEncIv, encryptedData);
      this.scpEncIv = encryptedData.slice(-16);
      let L3 = decryptedData.length - 1;
      while (L3 >= 0 && decryptedData[L3] !== 128) L3--;
      if (L3 < 0) throw new Error("SCP: Invalid padding in decrypted response");
      return decryptedData.slice(0, L3);
    } else {
      const decryptedData = await aesCbcDecrypt(this.key, this.iv, data);
      let L3 = decryptedData.length - 1;
      while (L3 >= 0 && decryptedData[L3] !== 128) L3--;
      if (L3 < 0) throw new Error("SCP: Invalid padding in decrypted response");
      this.iv = data.slice(-16);
      return decryptedData.slice(0, L3);
    }
  }
  // ============================================================
  // Loader commands
  // ============================================================
  async selectSegment(baseAddress) {
    const data = new Uint8Array(5);
    data[0] = 5;
    data[1] = baseAddress >> 24 & 255;
    data[2] = baseAddress >> 16 & 255;
    data[3] = baseAddress >> 8 & 255;
    data[4] = baseAddress & 255;
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async loadSegmentChunk(offset, chunk) {
    const data = new Uint8Array(3 + chunk.length);
    data[0] = 6;
    data[1] = offset >> 8 & 255;
    data[2] = offset & 255;
    data.set(chunk, 3);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async flushSegment() {
    await this.exchange(this.cla, 0, 0, 0, new Uint8Array([7]));
  }
  async crcSegment(offsetSegment, lengthSegment, crcExpected) {
    const data = new Uint8Array(9);
    data[0] = 8;
    data[1] = offsetSegment >> 8 & 255;
    data[2] = offsetSegment & 255;
    data[3] = lengthSegment >> 24 & 255;
    data[4] = lengthSegment >> 16 & 255;
    data[5] = lengthSegment >> 8 & 255;
    data[6] = lengthSegment & 255;
    data[7] = crcExpected >> 8 & 255;
    data[8] = crcExpected & 255;
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async boot(bootAddr, signature = null) {
    bootAddr |= 1;
    let data;
    if (signature !== null) {
      data = new Uint8Array(6 + signature.length);
      data[0] = 9;
      data[1] = bootAddr >> 24 & 255;
      data[2] = bootAddr >> 16 & 255;
      data[3] = bootAddr >> 8 & 255;
      data[4] = bootAddr & 255;
      data[5] = signature.length;
      data.set(signature, 6);
    } else {
      data = new Uint8Array(5);
      data[0] = 9;
      data[1] = bootAddr >> 24 & 255;
      data[2] = bootAddr >> 16 & 255;
      data[3] = bootAddr >> 8 & 255;
      data[4] = bootAddr & 255;
    }
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async commit(signature = null) {
    let data;
    if (signature !== null) {
      data = new Uint8Array(2 + signature.length);
      data[0] = 9;
      data[1] = signature.length;
      data.set(signature, 2);
    } else {
      data = new Uint8Array([9]);
    }
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async createAppNoInstallParams(appFlags, appLength, appName, icon = null, path = null, iconOffset = null, iconSize = null, appVersion = null) {
    let dataLen = 1 + 4 + 4 + 1 + appName.length;
    if (iconOffset === null) {
      dataLen += icon !== null ? 1 + icon.length : 1;
    }
    if (path !== null) {
      dataLen += 1 + path.length;
    } else {
      dataLen += 1;
    }
    if (iconOffset !== null) dataLen += 6;
    if (appVersion !== null) dataLen += 1 + appVersion.length;
    const data = new Uint8Array(dataLen);
    let offset = 0;
    data[offset++] = 11;
    data[offset++] = appLength >> 24 & 255;
    data[offset++] = appLength >> 16 & 255;
    data[offset++] = appLength >> 8 & 255;
    data[offset++] = appLength & 255;
    data[offset++] = appFlags >> 24 & 255;
    data[offset++] = appFlags >> 16 & 255;
    data[offset++] = appFlags >> 8 & 255;
    data[offset++] = appFlags & 255;
    data[offset++] = appName.length;
    data.set(appName, offset);
    offset += appName.length;
    if (iconOffset === null) {
      if (icon !== null) {
        data[offset++] = icon.length;
        data.set(icon, offset);
        offset += icon.length;
      } else {
        data[offset++] = 0;
      }
    }
    if (path !== null) {
      data[offset++] = path.length;
      data.set(path, offset);
      offset += path.length;
    } else {
      data[offset++] = 0;
    }
    if (iconOffset !== null) {
      data[offset++] = iconOffset >> 24 & 255;
      data[offset++] = iconOffset >> 16 & 255;
      data[offset++] = iconOffset >> 8 & 255;
      data[offset++] = iconOffset & 255;
      data[offset++] = iconSize >> 8 & 255;
      data[offset++] = iconSize & 255;
    }
    if (appVersion !== null) {
      data[offset++] = appVersion.length;
      data.set(appVersion, offset);
    }
    this.createappParams = null;
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async createApp(codeLength, apiLevel = 0, dataLength = 0, installParamsLength = 0, flags = 0, bootOffset = 1) {
    let params;
    if (apiLevel !== -1) {
      params = new Uint8Array(21);
      params[0] = apiLevel;
      putUint32(params, 1, codeLength);
      putUint32(params, 5, dataLength);
      putUint32(params, 9, installParamsLength);
      putUint32(params, 13, flags);
      putUint32(params, 17, bootOffset);
    } else {
      params = new Uint8Array(20);
      putUint32(params, 0, codeLength);
      putUint32(params, 4, dataLength);
      putUint32(params, 8, installParamsLength);
      putUint32(params, 12, flags);
      putUint32(params, 16, bootOffset);
    }
    this.createappParams = params;
    const data = new Uint8Array(1 + params.length);
    data[0] = 11;
    data.set(params, 1);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async deleteApp(appName) {
    const data = new Uint8Array(2 + appName.length);
    data[0] = 12;
    data[1] = appName.length;
    data.set(appName, 2);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async deleteAppByHash(appFullHash) {
    if (appFullHash.length !== 32) throw new Error("Invalid hash: sha256 expected");
    const data = new Uint8Array(33);
    data[0] = 21;
    data.set(appFullHash, 1);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Load application data from hex file
   * @returns {Promise<string>} SHA256 hash
   */
  async load(eraseU8, maxLengthPerApdu, hexFile, options = {}) {
    const { reverse = false, doCRC = true, targetId = null, targetVersion = null } = options;
    if (maxLengthPerApdu > this.maxMtu) {
      maxLengthPerApdu = this.maxMtu;
    }
    let initialAddress = this.relative ? hexFile.minAddr() : 0;
    const hashData = [];
    if (targetId !== null && (targetId & 15) > 3) {
      const tv = targetVersion || "";
      const targetData = new Uint8Array(4 + tv.length);
      putUint32(targetData, 0, targetId);
      if (tv.length > 0) {
        targetData.set(new TextEncoder().encode(tv), 4);
      }
      hashData.push(targetData);
    }
    if (this.createappParams) {
      hashData.push(this.createappParams);
    }
    let areas = hexFile.getAreas();
    if (reverse) areas = [...areas].reverse();
    for (const area of areas) {
      const startAddress = area.getStart() - initialAddress;
      const data = area.getData();
      if (!this.createpackParams) {
        await this.selectSegment(startAddress);
      }
      if (data.length === 0) continue;
      if (data.length > 65536) throw new Error("Invalid data size for loader");
      const crc = this.crc16(data);
      let offset = 0;
      let length = data.length;
      if (reverse) offset = length;
      while (length > 0) {
        let chunkLen;
        if (length > maxLengthPerApdu - LOAD_SEGMENT_CHUNK_HEADER_LENGTH - MIN_PADDING_LENGTH - SCP_MAC_LENGTH) {
          chunkLen = maxLengthPerApdu - LOAD_SEGMENT_CHUNK_HEADER_LENGTH - MIN_PADDING_LENGTH - SCP_MAC_LENGTH;
          if (chunkLen % 16 !== 0) chunkLen -= chunkLen % 16;
        } else {
          chunkLen = length;
        }
        if (this.cleardataBlockLen && chunkLen % this.cleardataBlockLen) {
          if (chunkLen < this.cleardataBlockLen) throw new Error("Cannot transport non-block-aligned data");
          chunkLen -= chunkLen % this.cleardataBlockLen;
        }
        let chunk;
        if (reverse) {
          chunk = data.slice(offset - chunkLen, offset);
          await this.loadSegmentChunk(offset - chunkLen, chunk);
        } else {
          chunk = data.slice(offset, offset + chunkLen);
          hashData.push(chunk);
          await this.loadSegmentChunk(offset, chunk);
        }
        if (reverse) {
          offset -= chunkLen;
        } else {
          offset += chunkLen;
        }
        length -= chunkLen;
      }
      if (!this.createpackParams) await this.flushSegment();
      if (doCRC) await this.crcSegment(0, data.length, crc);
    }
    const totalLen = hashData.reduce((sum, arr) => sum + arr.length, 0);
    const combined = new Uint8Array(totalLen);
    let pos = 0;
    for (const arr of hashData) {
      combined.set(arr, pos);
      pos += arr.length;
    }
    return bytesToHex5(sha256(combined));
  }
  async run(bootOffset = 1, signature = null) {
    await this.boot(bootOffset, signature);
  }
  async resetCustomCA() {
    await this.exchange(this.cla, 0, 0, 0, new Uint8Array([19]));
  }
  async setupCustomCA(name, publicKey) {
    const nameBytes = new TextEncoder().encode(name);
    const data = new Uint8Array(1 + 1 + nameBytes.length + 1 + publicKey.length);
    let offset = 0;
    data[offset++] = 18;
    data[offset++] = nameBytes.length;
    data.set(nameBytes, offset);
    offset += nameBytes.length;
    data[offset++] = publicKey.length;
    data.set(publicKey, offset);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  async runApp(name) {
    await this.exchange(this.cla, 216, 0, 0, name);
  }
  async getVersion() {
    const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([16]));
    return { raw: response };
  }
  async listApp(restart = true) {
    const result = [];
    while (true) {
      const p1 = restart ? 0 : 1;
      restart = false;
      const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([14]));
      if (response.length === 0) break;
      let offset = 0;
      while (offset < response.length) {
        const item = {};
        item.flags = response[offset] << 24 | response[offset + 1] << 16 | response[offset + 2] << 8 | response[offset + 3];
        offset += 4;
        item.hash_code_data = response.slice(offset, offset + 32);
        offset += 32;
        item.hash = response.slice(offset, offset + 32);
        offset += 32;
        const nameLen = response[offset++];
        item.name = new TextDecoder().decode(response.slice(offset, offset + nameLen));
        offset += nameLen;
        result.push(item);
      }
    }
    return result;
  }
  async getMemInfo() {
    const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([17]));
    const r = response;
    return {
      systemSize: r[0] << 24 | r[1] << 16 | r[2] << 8 | r[3],
      applicationsSize: r[4] << 24 | r[5] << 16 | r[6] << 8 | r[7],
      freeSize: r[8] << 24 | r[9] << 16 | r[10] << 8 | r[11],
      usedAppSlots: r[12] << 24 | r[13] << 16 | r[14] << 8 | r[15],
      totalAppSlots: r[16] << 24 | r[17] << 16 | r[18] << 8 | r[19]
    };
  }
};
function putUint32(buf, offset, value) {
  buf[offset] = value >> 24 & 255;
  buf[offset + 1] = value >> 16 & 255;
  buf[offset + 2] = value >> 8 & 255;
  buf[offset + 3] = value & 255;
}
function bytesToHex5(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesToBigInt2(bytes) {
  let result = 0n;
  for (const byte of bytes) {
    result = result << 8n | BigInt(byte);
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

// src/deployed.js
function uint32ToBytes(val) {
  return new Uint8Array([val >> 24 & 255, val >> 16 & 255, val >> 8 & 255, val & 255]);
}
async function getDeployedSecretV2(dongle, masterPrivate, targetId, signerCertChain = null, ecdhSecretFormat = null) {
  const testMaster = new PrivateKey(masterPrivate);
  const testMasterPublic = testMaster.pubkey.serialize(false);
  const targetIdBytes = uint32ToBytes(targetId);
  if ((targetId & 15) < 2) {
    throw new Error("Target ID does not support SCP V2+");
  }
  async function rawExchange(apdu2) {
    if (typeof dongle.exchangeRaw === "function") {
      return await dongle.exchangeRaw(apdu2);
    }
    try {
      const data = await dongle.exchange(apdu2);
      return { data, sw: 36864 };
    } catch (e) {
      if (e.sw) return { data: e.data || new Uint8Array(0), sw: e.sw };
      throw e;
    }
  }
  console.log(`SCP: IDENTIFY targetId=0x${targetId.toString(16)}`);
  let apdu = new Uint8Array([224, 4, 0, 0, targetIdBytes.length, ...targetIdBytes]);
  let result = await rawExchange(apdu);
  if (result.sw !== 36864) {
    console.warn(`SCP: IDENTIFY SW=0x${result.sw.toString(16)}`);
  }
  const nonce = randomBytes2(8);
  apdu = new Uint8Array([224, 80, 0, 0, nonce.length, ...nonce]);
  result = await rawExchange(apdu);
  if (result.sw !== 36864) {
    throw new Error(`SCP: GET_NONCE failed SW=0x${result.sw.toString(16)}`);
  }
  const authInfo = result.data;
  if (authInfo.length < 12) {
    throw new Error(`SCP: GET_NONCE insufficient data: ${authInfo.length} bytes (need 12+)`);
  }
  const batchSignerSerial = authInfo.slice(0, 4);
  const deviceNonce = authInfo.slice(4, 12);
  console.log(`SCP: GET_NONCE ok, batchSigner=${bytesToHex3(batchSignerSerial)}, nonce=${bytesToHex3(nonce)}, deviceNonce=${bytesToHex3(deviceNonce)}`);
  if (signerCertChain) {
    for (const cert of signerCertChain) {
      apdu = new Uint8Array([224, 81, 0, 0, cert.length, ...cert]);
      result = await rawExchange(apdu);
      if (result.sw !== 36864) {
        console.warn(`SCP: Signer cert SW=0x${result.sw.toString(16)}`);
      }
    }
  } else {
    console.log("SCP: Using test master key (self-signed)");
    const dataToSign = new Uint8Array([1, ...testMasterPublic]);
    const signature = testMaster.ecdsaSign(dataToSign);
    const signatureDer = testMaster.ecdsaSerialize(signature);
    console.log(`SCP: Master cert: pubLen=${testMasterPublic.length}, sigLen=${signatureDer.length}, sigDer=${bytesToHex3(signatureDer.slice(0, 6))}...`);
    const certificate = new Uint8Array([
      testMasterPublic.length,
      ...testMasterPublic,
      signatureDer.length,
      ...signatureDer
    ]);
    apdu = new Uint8Array([224, 81, 0, 0, certificate.length, ...certificate]);
    console.log(`SCP: VALIDATE_CERT master APDU len=${apdu.length}, cert len=${certificate.length}`);
    result = await rawExchange(apdu);
    if (result.sw !== 36864) {
      console.warn(`SCP: Master cert SW=0x${result.sw.toString(16)} (continuing - sideload mode)`);
    } else {
      console.log("SCP: Master cert accepted");
    }
  }
  const ephemeralPrivate = new PrivateKey();
  const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
  console.log(`SCP: Ephemeral pub=${bytesToHex3(ephemeralPublic).slice(0, 16)}...`);
  const ephDataToSign = new Uint8Array([17, ...nonce, ...deviceNonce, ...ephemeralPublic]);
  const ephSignature = testMaster.ecdsaSign(ephDataToSign);
  const ephSignatureDer = testMaster.ecdsaSerialize(ephSignature);
  const ephCertificate = new Uint8Array([
    ephemeralPublic.length,
    ...ephemeralPublic,
    ephSignatureDer.length,
    ...ephSignatureDer
  ]);
  apdu = new Uint8Array([224, 81, 128, 0, ephCertificate.length, ...ephCertificate]);
  console.log(`SCP: VALIDATE_CERT ephemeral APDU len=${apdu.length}`);
  result = await rawExchange(apdu);
  if (result.sw !== 36864) {
    console.warn(`SCP: Ephemeral cert SW=0x${result.sw.toString(16)} (continuing)`);
  }
  let lastDevPubKey = new PublicKey(testMasterPublic, true);
  let devicePublicKey = null;
  for (let index = 0; index < 2; index++) {
    const p1 = index === 0 ? 0 : 128;
    const certApdu = new Uint8Array([224, 82, p1, 0, 0]);
    const certResult = await rawExchange(certApdu);
    if (certResult.sw !== 36864) {
      console.warn(`SCP: GET_CERT[${index}] SW=0x${certResult.sw.toString(16)}`);
    }
    const certResponse = certResult.data;
    if (!certResponse || certResponse.length === 0) {
      console.warn(`SCP: GET_CERT[${index}] empty response - skipping`);
      continue;
    }
    console.log(`SCP: GET_CERT[${index}] ${certResponse.length} bytes`);
    let offset = 0;
    const headerLen = certResponse[offset++];
    const certHeader = certResponse.slice(offset, offset + headerLen);
    offset += headerLen;
    const pubKeyLen = certResponse[offset++];
    const certPublicKey = certResponse.slice(offset, offset + pubKeyLen);
    offset += pubKeyLen;
    const sigLen = certResponse[offset++];
    const certSignatureArray = certResponse.slice(offset, offset + sigLen);
    const certSignature = lastDevPubKey.ecdsaDeserialize(certSignatureArray);
    let certSignedData;
    if (index === 0) {
      devicePublicKey = certPublicKey;
      certSignedData = new Uint8Array([2, ...certHeader, ...certPublicKey]);
    } else {
      certSignedData = new Uint8Array([18, ...deviceNonce, ...nonce, ...certPublicKey]);
    }
    const verified = lastDevPubKey.ecdsaVerify(certSignedData, certSignature);
    if (!verified) {
      if (index === 0) {
        console.log("SCP: Broken certificate chain - loading from user key");
      } else {
        throw new Error("SCP: Broken certificate chain at device ephemeral cert");
      }
    } else {
      console.log(`SCP: Device cert[${index}] verified`);
    }
    lastDevPubKey = new PublicKey(certPublicKey, true);
    console.log(`SCP: GET_CERT[${index}] pubKey=${bytesToHex3(certPublicKey).slice(0, 16)}... (${certPublicKey.length}B)`);
  }
  result = await rawExchange(new Uint8Array([224, 83, 0, 0, 0]));
  if (result.sw !== 36864) {
    console.warn(`SCP: COMMIT SW=0x${result.sw.toString(16)}`);
  }
  const ephemeralPrivBytes = hexToBytes2(ephemeralPrivate.serialize());
  console.log(`SCP: ECDH devPub=${bytesToHex3(lastDevPubKey.serialize(false)).slice(0, 16)}...`);
  const secret = lastDevPubKey.ecdh(ephemeralPrivBytes);
  console.log(`SCP: ECDH secret=${bytesToHex3(secret)}`);
  console.log("SCP: Secure channel established");
  if (ecdhSecretFormat === 1 || (targetId & 15) === 2) {
    return secret.slice(0, 16);
  } else if ((targetId & 15) >= 3) {
    return { ecdh_secret: secret, devicePublicKey };
  }
  return secret.slice(0, 16);
}
async function getDeployedSecretV1(dongle, masterPrivate, targetId) {
  const testMaster = new PrivateKey(masterPrivate);
  const testMasterPublic = testMaster.pubkey.serialize(false);
  const targetIdBytes = uint32ToBytes(targetId);
  let apdu = new Uint8Array([224, 4, 0, 0, targetIdBytes.length, ...targetIdBytes]);
  await dongle.exchange(apdu);
  const nonce = randomBytes2(8);
  apdu = new Uint8Array([224, 80, 0, 0, nonce.length, ...nonce]);
  const batchInfo = await dongle.exchange(apdu);
  const deviceNonce = batchInfo.slice(4, 12);
  const dataToSign = new Uint8Array([1, ...testMasterPublic]);
  const signature = testMaster.ecdsaSign(dataToSign);
  const signatureDer = testMaster.ecdsaSerialize(signature);
  const certificate = new Uint8Array([
    testMasterPublic.length,
    ...testMasterPublic,
    signatureDer.length,
    ...signatureDer
  ]);
  const ephemeralPrivate = new PrivateKey();
  const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
  const ephDataToSign = new Uint8Array([17, ...nonce, ...deviceNonce, ...ephemeralPublic]);
  const ephSig = testMaster.ecdsaSign(ephDataToSign);
  const ephSigDer = testMaster.ecdsaSerialize(ephSig);
  const fullCert = new Uint8Array([
    ...certificate,
    ephemeralPublic.length,
    ...ephemeralPublic,
    ephSigDer.length,
    ...ephSigDer
  ]);
  apdu = new Uint8Array([224, 81, 0, 0, fullCert.length, ...fullCert]);
  await dongle.exchange(apdu);
  let lastPubKey = new PublicKey(testMasterPublic, true);
  let index = 0;
  while (true) {
    const certResponse = await dongle.exchange(new Uint8Array([224, 82, 0, 0, 0]));
    if (certResponse.length === 0) break;
    let offset = 0;
    const headerLen = certResponse[offset++];
    offset += headerLen;
    const pubKeyLen = certResponse[offset++];
    const certPublicKey = certResponse.slice(offset, offset + pubKeyLen);
    offset += pubKeyLen;
    lastPubKey = new PublicKey(certPublicKey, true);
    index++;
    if (index >= 2) break;
  }
  await dongle.exchange(new Uint8Array([224, 83, 0, 0, 0]));
  const ephemeralPrivBytes = hexToBytes2(ephemeralPrivate.serialize());
  const secret = lastPubKey.ecdh(ephemeralPrivBytes);
  return secret.slice(0, 16);
}

// src/loadApp.js
var PAGE_ALIGNMENT = 64;
var TARGET_IDS = {
  NANO_S: 823132164,
  NANO_S_PLUS: 856686596,
  NANO_X: 855638020,
  STAX: 857735172,
  FLEX: 858783748
};
var CURVES = {
  SECP256K1: 1,
  SECP256R1: 2,
  ED25519: 4,
  SLIP21: 8,
  BLS12381G1: 16
};
function parseBip32Path(path) {
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
function concatBytes2(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
async function loadApp(dongle, options) {
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
      console.log(`Generated random root public key: ${bytesToHex3(tempKey.pubkey.serialize(false))}`);
    }
  } else {
    rootPrivateKey = typeof rootPrivateKeyOption === "string" ? hexToBytes2(rootPrivateKeyOption) : rootPrivateKeyOption;
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
  path = concatBytes2(path, new Uint8Array([curveMask]));
  if (paths !== null) {
    for (const item of paths) {
      if (item.length !== 0) {
        path = concatBytes2(path, parseBip32Path(item));
      }
    }
  }
  if (pathSlip21 !== null) {
    for (const item of pathSlip21) {
      if (item.length !== 0) {
        path = concatBytes2(path, parseSlip21Path(item));
      }
    }
    if (paths === null || paths.length === 1 && paths[0].length === 0) {
      path = concatBytes2(path, new Uint8Array([0]));
    }
  }
  let iconData = icon;
  if (iconData !== null && typeof iconData === "string") {
    iconData = hexToBytes2(iconData);
  }
  let sig = signature;
  if (sig !== null && typeof sig === "string") {
    sig = hexToBytes2(sig);
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
          depValue = concatBytes2(depValue, encodelv(stringToBytes(depAppVersion)));
        }
        installParams = concatBytes2(installParams, encodetlv(BOLOS_TAG_DEPENDENCY, depValue));
      }
    }
    const shouldBuildInstallParams = !(appFlags & 2) && (installParamsSizeOption === null || installParamsSizeOption === 0);
    if (shouldBuildInstallParams) {
      installParams = concatBytes2(installParams, encodetlv(BOLOS_TAG_APPNAME, appNameBytes));
      if (appVersion !== null) {
        installParams = concatBytes2(installParams, encodetlv(BOLOS_TAG_APPVERSION, stringToBytes(appVersion)));
      }
      if (iconData !== null) {
        installParams = concatBytes2(installParams, encodetlv(BOLOS_TAG_ICON, iconData));
      }
      if (path.length > 0) {
        installParams = concatBytes2(installParams, encodetlv(BOLOS_TAG_DERIVEPATH, path));
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
    const masterPrivate = new PrivateKey(hexToBytes2(signPrivateKey));
    const sigObj = masterPrivate.ecdsaSign(hexToBytes2(hash), true);
    sig = masterPrivate.ecdsaSerialize(sigObj);
    if (debug) {
      console.log(`Application signature: ${bytesToHex3(sig)}`);
    }
  }
  if (tlv) {
    await loader.commit(sig);
  } else {
    await loader.run(bootAddr - printer.minAddr(), sig);
  }
  return hash;
}
async function deleteApp(dongle, appName, targetId, rootPrivateKey = null, debug = false) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes2(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  const appNameBytes = stringToBytes(appName);
  await loader.deleteApp(appNameBytes);
  if (debug) {
    console.log(`Deleted app: ${appName}`);
  }
}
async function listApps(dongle, targetId, rootPrivateKey = null) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes2(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.listApp();
}
async function getMemInfo(dongle, targetId, rootPrivateKey = null) {
  let rootKey;
  if (rootPrivateKey === null) {
    const tempKey = new PrivateKey();
    rootKey = tempKey.getPrivateKeyBytes();
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes2(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.getMemInfo();
}

// src/device.js
var TARGET_NAMES = Object.fromEntries(
  Object.entries(TARGET_IDS).map(([name, id]) => [id, name])
);
function readLv(buf, pos) {
  const len = buf[pos];
  return { value: buf.slice(pos + 1, pos + 1 + len), next: pos + 1 + len };
}
async function getDeviceInfo(dongle) {
  const apdu = new Uint8Array([224, 1, 0, 0, 0]);
  let data;
  try {
    data = await dongle.exchange(apdu);
  } catch (e) {
    throw new Error(`GET_VERSION refused (${e.message}): quit the running app and stay on the dashboard`);
  }
  if (data.length < 5) {
    throw new Error("GET_VERSION: response too short, is the device on the dashboard?");
  }
  const targetId = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
  const dec = new TextDecoder();
  let pos = 4;
  const se = readLv(data, pos);
  pos = se.next;
  let flags = new Uint8Array(0);
  let mcu = new Uint8Array(0);
  if (pos < data.length) {
    const f = readLv(data, pos);
    flags = f.value;
    pos = f.next;
  }
  if (pos < data.length) {
    const m = readLv(data, pos);
    mcu = m.value;
    pos = m.next;
  }
  return {
    targetId,
    targetName: TARGET_NAMES[targetId] || null,
    seVersion: dec.decode(se.value),
    mcuVersion: dec.decode(mcu),
    flags
  };
}

// src/apduScript.js
var CMD_DELETE_APP = 12;
var CMD_CREATE_APP = 11;
var CMD_LOAD = 6;
function parseApduScript(text) {
  const apdus = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!/^[0-9a-fA-F]+$/.test(line) || line.length % 2 !== 0) {
      throw new Error(`app.apdu line ${i + 1}: not hex`);
    }
    const bytes = hexToBytes2(line);
    if (bytes.length < 5) throw new Error(`app.apdu line ${i + 1}: too short`);
    const [cla, ins, p1, p2, lc] = bytes;
    const data = bytes.slice(5);
    if (cla !== 224 || ins !== 0 || p1 !== 0 || p2 !== 0) {
      throw new Error(`app.apdu line ${i + 1}: not a loader APDU (${bytesToHex3(bytes.slice(0, 4))})`);
    }
    if (lc !== data.length) {
      throw new Error(`app.apdu line ${i + 1}: Lc=${lc} but ${data.length} data bytes`);
    }
    apdus.push({ cla, ins, p1, p2, data });
  }
  if (apdus.length === 0) throw new Error("app.apdu: empty script");
  return apdus;
}
function describeApduScript(apdus) {
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
  if (!hasCreate) throw new Error("app.apdu: no createApp command, not a load script");
  return { appName, loadChunks, loadBytes, apdus: apdus.length };
}
async function replayApduScript(dongle, text, options = {}) {
  let {
    targetId = null,
    rootPrivateKey: rootPrivateKeyOption = null,
    delete: deleteFirst = true,
    onProgress = null,
    debug = false
  } = options;
  if (targetId === null) targetId = (await getDeviceInfo(dongle)).targetId;
  const apdus = parseApduScript(text);
  const info = describeApduScript(apdus);
  let rootPrivateKey;
  if (rootPrivateKeyOption === null) {
    rootPrivateKey = new PrivateKey().getPrivateKeyBytes();
  } else {
    rootPrivateKey = typeof rootPrivateKeyOption === "string" ? hexToBytes2(rootPrivateKeyOption) : rootPrivateKeyOption;
  }
  if (debug) console.log(`replayApduScript: ${info.appName} ${info.apdus} APDUs, ${info.loadBytes}B in ${info.loadChunks} chunks`);
  const secret = await getDeployedSecretV2(dongle, rootPrivateKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret, true, null);
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

// src/catalog.js
var TARGET_DIRS = {
  [TARGET_IDS.NANO_S_PLUS]: "nanos2",
  [TARGET_IDS.NANO_X]: "nanox",
  [TARGET_IDS.STAX]: "stax",
  [TARGET_IDS.FLEX]: "flex"
  // Apex P: ZKNOX-HW-PRIVACY ships build/apex_p/, but its targetId is not in
  // TARGET_IDS yet. Add TARGET_IDS.APEX_P from the SDK's Makefile.target and
  // map it here.
};
var DIR_ARTIFACT_FILES = ["app.hex", "app.map", "Makefile", "manifest.json"];
function targetDir(targetId) {
  const dir = TARGET_DIRS[targetId];
  if (!dir) {
    throw new Error(`Unsupported targetId 0x${targetId.toString(16)}: no build directory known`);
  }
  return dir;
}
function rawBase(entry) {
  const ref = entry.ref || "main";
  return `https://raw.githubusercontent.com/${entry.repo}/${ref}`;
}
function resolveCatalogFiles(entry, targetId) {
  if (entry.repo) {
    const profile = entry.profile || "prod";
    const bin = `${rawBase(entry)}/${entry.binDir || "build/{profile}/{target}"}`.replace("{profile}", profile).replace("{target}", targetDir(targetId));
    return { "app.apdu": `${bin}/app.apdu`, "artifact-manifest.txt": `${bin}/artifact-manifest.txt` };
  }
  if (entry.dir) {
    return Object.fromEntries(DIR_ARTIFACT_FILES.map((f) => [f, `${entry.dir}/${f}`]));
  }
  throw new Error(`Catalog entry '${entry.id}' has neither 'repo' nor 'dir'`);
}
async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`${url}: HTTP ${r.status}`);
  }
  return r.text();
}
function parseArtifactManifest(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
async function fetchCatalogApp(entry, targetId = null, dongle = null) {
  if (targetId === null) {
    if (dongle === null) throw new Error("fetchCatalogApp: targetId or dongle required");
    targetId = (await getDeviceInfo(dongle)).targetId;
  }
  const urls = resolveCatalogFiles(entry, targetId);
  if (entry.repo) {
    const profile = entry.profile || "prod";
    const apdu = await fetchText(urls["app.apdu"]);
    const info = describeApduScript(parseApduScript(apdu));
    let manifest = null;
    try {
      manifest = parseArtifactManifest(await fetchText(urls["artifact-manifest.txt"]));
    } catch (e) {
      manifest = null;
    }
    if (manifest && manifest.mode && manifest.mode !== "prod" && profile !== "dev") {
      throw new Error(`${entry.id}: refusing a ${manifest.mode} build under profile '${profile}'`);
    }
    return { layout: "repo", apdu, info, manifest, profile, urls, targetId };
  }
  const [hex, map, makefile, manifestText] = await Promise.all([
    fetchText(urls["app.hex"]),
    fetchText(urls["app.map"]),
    fetchText(urls["Makefile"]),
    fetchText(urls["manifest.json"])
  ]);
  return { layout: "dir", hex, map, makefile, manifest: JSON.parse(manifestText), urls, targetId };
}

// src/transportBle.js
var DEFAULT_TIMEOUT2 = 3e4;
var TAG_APDU = 5;
var TAG_MTU = 8;
function ledgerUuid(model, idx) {
  return `13d63400-2c97-${model}-000${idx}-4c6564676572`;
}
var BLE_MODELS = [
  { name: "NANO_X", service: ledgerUuid("0004", 0), notify: ledgerUuid("0004", 1), write: ledgerUuid("0004", 2), writeCmd: ledgerUuid("0004", 3) },
  { name: "STAX", service: ledgerUuid("6004", 0), notify: ledgerUuid("6004", 1), write: ledgerUuid("6004", 2), writeCmd: ledgerUuid("6004", 3) },
  { name: "FLEX", service: ledgerUuid("3004", 0), notify: ledgerUuid("3004", 1), write: ledgerUuid("3004", 2), writeCmd: ledgerUuid("3004", 3) }
];
function bytesToHex6(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var TransportWebBLE = class _TransportWebBLE {
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
    this._queue = [];
    this._waiter = null;
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }
  static isSupported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }
  async open() {
    if (this.opened) return;
    this.server = await this.device.gatt.connect();
    this.device.addEventListener("gattserverdisconnected", this._onDisconnect);
    let service = null;
    for (const m of BLE_MODELS) {
      try {
        service = await this.server.getPrimaryService(m.service);
        this.model = m;
        break;
      } catch (e) {
      }
    }
    if (!service) throw new CommException("No Ledger BLE service found on this device");
    this.notifyChar = await service.getCharacteristic(this.model.notify);
    this.writeChar = await service.getCharacteristic(this.model.write);
    try {
      this.writeCmdChar = await service.getCharacteristic(this.model.writeCmd);
    } catch (e) {
      this.writeCmdChar = null;
    }
    this.notifyChar.addEventListener("characteristicvaluechanged", this._onNotify);
    await this.notifyChar.startNotifications();
    this.opened = true;
    await this._inferMtu();
    if (this.debug) console.log(`BLE: ${this.model.name} connected, mtu=${this.mtu}`);
  }
  async close() {
    if (!this.opened) return;
    this.opened = false;
    try {
      this.notifyChar.removeEventListener("characteristicvaluechanged", this._onNotify);
    } catch (e) {
    }
    try {
      await this.notifyChar.stopNotifications();
    } catch (e) {
    }
    this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
  _onDisconnect() {
    this.opened = false;
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      clearTimeout(w.timeoutId);
      w.reject(new CommException("BLE device disconnected"));
    }
  }
  _onNotify(event) {
    const value = new Uint8Array(event.target.value.buffer);
    if (this.debug) console.log("BLE <= frame " + bytesToHex6(value));
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
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
        reject(new CommException("Timeout waiting for BLE notification"));
      }, timeout);
      this._waiter = { resolve, reject, timeoutId };
    });
  }
  async _writeFrame(frame) {
    if (this.debug) console.log("BLE => frame " + bytesToHex6(frame));
    if (this.writeCmdChar) {
      await this.writeCmdChar.writeValueWithoutResponse(frame);
    } else {
      await this.writeChar.writeValueWithResponse(frame);
    }
  }
  async _inferMtu() {
    this._queue.length = 0;
    await this._writeFrame(new Uint8Array([TAG_MTU, 0, 0, 0, 0]));
    const frame = await this._nextFrame(5e3);
    if (frame[0] !== TAG_MTU || frame.length < 6) {
      throw new CommException("Unexpected MTU response " + bytesToHex6(frame));
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
      frame[1] = seq >> 8 & 255;
      frame[2] = seq & 255;
      if (seq === 0) {
        frame[3] = apdu.length >> 8 & 255;
        frame[4] = apdu.length & 255;
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
        continue;
      }
      const idx = frame[1] << 8 | frame[2];
      if (idx !== seq) throw new CommException(`BLE sequence error: got ${idx}, expected ${seq}`);
      let payload;
      if (idx === 0) {
        expected = frame[3] << 8 | frame[4];
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
  async exchangeRaw(apdu, timeout = DEFAULT_TIMEOUT2) {
    if (!this.opened) throw new CommException("Device not opened");
    if (this.debug) console.log("BLE => " + bytesToHex6(apdu));
    this._queue.length = 0;
    await this._sendApdu(apdu);
    const response = await this._receiveApdu(timeout);
    if (response.length < 2) throw new CommException("Response too short");
    const swOffset = response.length - 2;
    const sw = response[swOffset] << 8 | response[swOffset + 1];
    const data = response.slice(0, swOffset);
    if (this.debug) console.log("BLE <= " + bytesToHex6(data) + " SW=" + sw.toString(16).padStart(4, "0"));
    return { data, sw };
  }
  async exchange(apdu, timeout = DEFAULT_TIMEOUT2) {
    const { data, sw } = await this.exchangeRaw(apdu, timeout);
    if (sw !== 36864 && (sw & 65280) !== 24832 && (sw & 65280) !== 27648) {
      throw new CommException(`Invalid status ${sw.toString(16).padStart(4, "0")} (${getPossibleErrorCause(sw)})`, sw, data);
    }
    return data;
  }
  apduMaxDataSize() {
    return 255;
  }
  // Opens the browser's Bluetooth chooser filtered on Ledger services.
  static async request(debug = false) {
    if (!_TransportWebBLE.isSupported()) {
      throw new CommException("Web Bluetooth not supported in this browser (Chrome/Edge, https or localhost)");
    }
    const services = BLE_MODELS.map((m) => m.service);
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: services.map((s) => ({ services: [s] })),
        optionalServices: services
      });
    } catch (e) {
      throw new CommException("No Ledger selected in the Bluetooth chooser (" + e.message + ")");
    }
    const transport = new _TransportWebBLE(device, debug);
    await transport.open();
    return transport;
  }
};

// src/firmwareUpdater.js
var FIRMWARE_DEFAULTS = Object.freeze({
  liveCommonVersion: "34.51.0",
  provider: 1,
  apiBase: "https://manager.api.live.ledger.com/api",
  socketBase: "wss://scriptrunner.api.live.ledger.com/update",
  apduTimeoutMs: 6e4,
  // ordinary APDU (socket exchange / bulk)
  userConfirmTimeoutMs: 9e5,
  // APDU blocked on an on-device confirmation
  maxFlashRepetitions: 5,
  reconnectPollMs: 1e3,
  reconnectAutoMs: 25e3
  // silent getDevices() polling before asking the user
});
var SW_OK = 36864;
var SW_LOCKED = 21781;
var SW_USER_REFUSED = 21761;
var SW_CONDITIONS_NOT_SATISFIED = 27013;
var FirmwareError = class extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "FirmwareError";
    this.code = code;
  }
};
function getDeviceModelName(targetId) {
  switch (targetId & 4294901760) {
    case 823132160:
      return "Nano S";
    case 855638016:
      return "Nano X";
    case 856686592:
      return "Nano S Plus";
    case 857735168:
      return "Stax";
    case 858783744:
      return "Flex";
    default:
      return "Unknown";
  }
}
function u32be(data, i) {
  return (data[i] << 24 | data[i + 1] << 16 | data[i + 2] << 8 | data[i + 3]) >>> 0;
}
function cstr(bytes) {
  if (bytes.length && bytes[bytes.length - 1] === 0) bytes = bytes.slice(0, -1);
  return new TextDecoder().decode(bytes);
}
function parseGetVersion(data) {
  let i = 0;
  const targetId = u32be(data, i);
  i += 4;
  const rawVersionLength = data[i++];
  let rawVersion = new TextDecoder().decode(data.slice(i, i + rawVersionLength));
  i += rawVersionLength;
  const flagsLength = data[i++];
  let flags = Array.from(data.slice(i, i + flagsLength));
  i += flagsLength;
  if (!rawVersionLength) {
    rawVersion = "0.0.0";
    flags = [];
  }
  const isBootloader = (targetId & 4026531840) !== 805306368;
  let mcuVersion = "", mcuBlVersion = null, seVersion = null, seTargetId = null, mcuTargetId = null;
  if (isBootloader) {
    mcuBlVersion = rawVersion;
    mcuTargetId = targetId;
    if (i < data.length) {
      const part1Length = data[i++];
      const part1 = data.slice(i, i + part1Length);
      i += part1Length;
      if (part1Length >= 5) {
        seVersion = new TextDecoder().decode(part1);
        const part2Length = data[i++];
        const part2 = data.slice(i, i + part2Length);
        if (part2.length >= 4) seTargetId = u32be(part2, 0);
      } else if (part1Length >= 4) {
        seTargetId = u32be(part1, 0);
      }
    }
  } else {
    seVersion = rawVersion;
    seTargetId = targetId;
    const mcuVersionLength = data[i++];
    mcuVersion = cstr(data.slice(i, i + mcuVersionLength));
    i += mcuVersionLength;
  }
  const isOSU = rawVersion.includes("-osu");
  const version = rawVersion.replace("-osu", "");
  const m = rawVersion.match(/([0-9]+.[0-9]+(.[0-9]+){0,1})?(-(.*))?/);
  const majMin = m && m[1] || "";
  return {
    targetId,
    rawVersion,
    version,
    majMin,
    flags,
    isBootloader,
    isOSU,
    seVersion,
    seTargetId,
    mcuVersion,
    mcuBlVersion,
    mcuTargetId,
    model: getDeviceModelName(isBootloader && seTargetId ? seTargetId : targetId),
    managerAllowed: !!(flags[0] & 8),
    pinValidated: !!(flags[0] & 128)
  };
}
function coerce(v) {
  const m = String(v || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
function semverGt(a, b) {
  const x = coerce(a), y = coerce(b);
  for (let k = 0; k < 3; k++) {
    if (x[k] !== y[k]) return x[k] > y[k];
  }
  return false;
}
function findBestMCU(mcus) {
  if (!mcus.length) return null;
  let best = mcus[0];
  for (let k = 1; k < mcus.length; k++) {
    if (semverGt(mcus[k].name, best.name)) best = mcus[k];
  }
  return best;
}
function getFlashMcuOrBootloaderDetails(deviceMajMin, mcuFromBootloaderVersion) {
  const bootloaderVersion = String(mcuFromBootloaderVersion || "").split(".").slice(0, 3).join(".");
  return { bootloaderVersion, isMcuUpdate: deviceMajMin === bootloaderVersion };
}
var FirmwareUpdater = class {
  /**
   * @param {object} opts
   * @param {object} opts.transport   - TransportWebHID-like (exchange(apdu, timeout) -> data, throws CommException with .sw)
   * @param {function} opts.reconnect - async (message, kind) => transport ; must run from a user gesture (WebHID/Bluetooth chooser), kind = 'usb' | 'ble' is the link the device was on
   * @param {function} [opts.onLog]      - (message, type) => void
   * @param {function} [opts.onProgress] - (percent, text) => void
   * @param {function} [opts.onEvent]    - (eventName, payload) => void
   */
  constructor(opts) {
    this.transport = opts.transport || null;
    this.reconnect = opts.reconnect;
    this.onLog = opts.onLog || (() => {
    });
    this.onProgress = opts.onProgress || (() => {
    });
    this.onEvent = opts.onEvent || (() => {
    });
    this.cfg = { ...FIRMWARE_DEFAULTS, ...opts.config || {} };
    this.provider = this.cfg.provider;
  }
  log(message, type = "info") {
    this.onLog(message, type);
  }
  progress(percent, text) {
    this.onProgress(Math.round(percent), text);
  }
  // ---- HTTP manager API ----
  async api(path, query = {}) {
    const q = new URLSearchParams({ livecommonversion: this.cfg.liveCommonVersion, ...query });
    const resp = await fetch(`${this.cfg.apiBase}/${path}?${q}`);
    if (!resp.ok) throw new FirmwareError("ManagerApiError", `${path}: HTTP ${resp.status}`);
    return resp.json();
  }
  /** port of device-core getLatestFirmwareForDevice. Returns null when up to date. */
  async getLatestFirmware(deviceInfo) {
    const provider = this.provider;
    const mcusPromise = this.api("mcu_versions");
    const deviceVersion = await this.api("get_device_version", { provider, target_id: deviceInfo.targetId });
    let osu;
    if (deviceInfo.isOSU) {
      osu = await this.api("get_osu_version", {
        device_version: deviceVersion.id,
        version_name: `${deviceInfo.version}-osu`,
        provider
      });
    } else {
      const current = await this.api("get_firmware_version", {
        device_version: deviceVersion.id,
        version_name: deviceInfo.version,
        provider
      });
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const latest = await this.api("get_latest_firmware", {
        salt,
        current_se_firmware_final_version: current.id,
        device_version: deviceVersion.id,
        provider
      });
      osu = latest.result === "null" ? null : latest.se_firmware_osu_version;
    }
    if (!osu) return null;
    const mcus = await mcusPromise;
    const currentMcu = mcus.find((m) => m.name === deviceInfo.mcuVersion);
    if (!currentMcu) throw new FirmwareError("UnknownMCU", `Unknown MCU version "${deviceInfo.mcuVersion}"`);
    const final = await this.api(`firmware_final_versions/${osu.next_se_firmware_final_version}`);
    const shouldFlashMCU = !final.mcu_versions.includes(currentMcu.id);
    return {
      osu,
      final,
      shouldFlashMCU,
      mcus,
      currentVersion: deviceInfo.version,
      targetVersion: final.version || final.name
    };
  }
  /** port of ManagerAPI.retrieveMcuVersion */
  retrieveMcuVersion(final, mcus) {
    const available = mcus.filter((m) => m.providers.includes(this.provider) && m.from_bootloader_version !== "none" && final.mcu_versions.includes(m.id));
    return findBestMCU(available);
  }
  // ---- device ----
  async getDeviceInfo(transport = this.transport) {
    const data = await transport.exchange(new Uint8Array([224, 1, 0, 0, 0]), this.cfg.apduTimeoutMs);
    return parseGetVersion(data);
  }
  /**
   * Device rebooted: wait for it to come back on the same link, then hand over to the
   * page (user gesture) if it does not.
   *  - BLE: the BluetoothDevice object survives the reboot, gatt.connect() needs no
   *    chooser. Nano X / Stax / Flex bootloader and OSU advertise the same service.
   *  - USB: already-paired HID devices are reopened silently; the bootloader and the
   *    OSU enumerate with another product id, which usually needs a new requestDevice.
   */
  async waitForDevice(message) {
    const previous = this.transport;
    const bleDevice = previous && previous.device && previous.device.gatt ? previous.device : null;
    if (previous) {
      try {
        await previous.close();
      } catch (e) {
      }
      this.transport = null;
    }
    const deadline = Date.now() + this.cfg.reconnectAutoMs;
    while (Date.now() < deadline) {
      await sleep(this.cfg.reconnectPollMs);
      const candidates = [];
      try {
        if (bleDevice) {
          candidates.push(new TransportWebBLE(bleDevice, false));
        } else if (navigator.hid) {
          for (const d of await navigator.hid.getDevices()) {
            if (d.vendorId === 11415) candidates.push(new TransportWebHID(d, false));
          }
        }
      } catch (e) {
      }
      for (const t of candidates) {
        try {
          await t.open();
          const info = await this.getDeviceInfo(t);
          this.transport = t;
          this.log(`Device back over ${bleDevice ? "Bluetooth" : "USB"}: ${info.isBootloader ? "bootloader " + info.rawVersion : info.rawVersion}`, "info");
          return info;
        } catch (e) {
          try {
            await t.close();
          } catch (_) {
          }
          if (e && e.sw === SW_LOCKED) this.log("Device is locked, unlock it to continue...", "warning");
        }
      }
    }
    this.transport = await this.reconnect(message, bleDevice ? "ble" : "usb");
    return this.getDeviceInfo();
  }
  // ---- scriptrunner socket (port of live-common socket/index.js) ----
  /**
   * @param {string} url
   * @param {object} o
   * @param {function} [o.onProgress] - (index, total) during bulk
   * @param {boolean} [o.unresponsiveExpectedDuringBulk] - bulk APDUs may wait for the user (firmware)
   * @param {boolean} [o.rebootExpectedAtEndOfBulk] - device drops the link right after the last bulk APDU
   */
  runSocket(url, o = {}) {
    const transport = this.transport;
    const cfg = this.cfg;
    const self = this;
    return new Promise((resolve, reject) => {
      let deviceError = null;
      let inBulkMode = false;
      let correctlyFinished = false;
      let settled = false;
      const done = (err2) => {
        if (settled) return;
        settled = true;
        if (err2) reject(err2);
        else resolve();
      };
      const ws = new WebSocket(url);
      ws.onopen = () => self.log("Connected to Ledger HSM", "info");
      ws.onerror = () => {
        if (inBulkMode) return;
        done(new FirmwareError("WebsocketConnectionError", "HSM websocket error"));
      };
      ws.onclose = () => {
        if (inBulkMode) return;
        if (correctlyFinished) done();
        else done(deviceError || new FirmwareError("WebsocketConnectionError", "HSM websocket closed"));
      };
      ws.onmessage = async (e) => {
        try {
          const input = JSON.parse(e.data);
          switch (input.query) {
            case "exchange": {
              deviceError = null;
              const apdu = hexToBytes2(input.data);
              const pendingAllowSecureChannel = apdu[0] === 224 && apdu[1] === 81;
              if (pendingAllowSecureChannel) self.onEvent("allowSecureChannelRequested");
              const timeout = pendingAllowSecureChannel ? cfg.userConfirmTimeoutMs : cfg.apduTimeoutMs;
              let status, data;
              try {
                data = await transport.exchange(apdu, timeout);
                status = SW_OK;
              } catch (err2) {
                if (!(err2 instanceof CommException) || err2.data == null) {
                  throw err2;
                }
                status = err2.sw;
                data = err2.data || new Uint8Array(0);
              }
              let response;
              if (status === SW_OK) {
                response = "success";
              } else if (status === SW_LOCKED) {
                throw new FirmwareError("DeviceLocked", "Device is locked");
              } else if ((status === SW_USER_REFUSED || status === SW_CONDITIONS_NOT_SATISFIED) && pendingAllowSecureChannel) {
                throw new FirmwareError("UserRefusedAllowManager", "Secure channel refused on device");
              } else {
                response = "error";
                deviceError = new FirmwareError("TransportStatusError", `Device returned 0x${status.toString(16)}`);
              }
              if (pendingAllowSecureChannel) self.onEvent("allowSecureChannelGranted");
              ws.send(JSON.stringify({ nonce: input.nonce, response, data: bytesToHex3(data) }));
              break;
            }
            case "bulk": {
              inBulkMode = true;
              ws.close();
              const apdus = (input.data || []).filter((d) => d !== "").map(hexToBytes2);
              const total = apdus.length;
              if (o.onProgress) o.onProgress(0, total);
              for (let i = 0; i < total; i++) {
                const last = i === total - 1;
                const timeout = o.unresponsiveExpectedDuringBulk ? cfg.userConfirmTimeoutMs : cfg.apduTimeoutMs;
                if (last && o.unresponsiveExpectedDuringBulk) self.onEvent("devicePermissionRequested");
                try {
                  await transport.exchange(apdus[i], timeout);
                } catch (err2) {
                  if (last && o.rebootExpectedAtEndOfBulk && isDisconnect(err2)) {
                    self.log("Device rebooted before acknowledging the last APDU (expected)", "info");
                    break;
                  }
                  throw mapFirmwareStatus(err2);
                }
                if (last && o.unresponsiveExpectedDuringBulk) self.onEvent("devicePermissionGranted");
                if (o.onProgress) o.onProgress(i + 1, total);
              }
              correctlyFinished = true;
              done();
              break;
            }
            case "success":
              if (inBulkMode) break;
              correctlyFinished = true;
              done();
              break;
            case "error":
              if (inBulkMode) break;
              throw new FirmwareError("DeviceSocketFail", `HSM error: ${input.data}`);
            case "warning":
              if (inBulkMode) break;
              self.log(`HSM warning: ${input.data}`, "warning");
              break;
            default:
              break;
          }
        } catch (err2) {
          deviceError = err2;
          try {
            ws.close();
          } catch (_) {
          }
          done(err2);
        }
      };
    });
  }
  socketUrl(path, query) {
    const q = new URLSearchParams({ livecommonversion: this.cfg.liveCommonVersion, ...query });
    return `${this.cfg.socketBase}/${path}?${q}`;
  }
  installOsu(targetId, osu, base, span) {
    this.log(`Installing OSU ${osu.name || ""}...`, "info");
    return this.runSocket(this.socketUrl("install", {
      targetId,
      perso: osu.perso,
      firmware: osu.firmware,
      firmwareKey: osu.firmware_key
    }), {
      unresponsiveExpectedDuringBulk: true,
      rebootExpectedAtEndOfBulk: true,
      onProgress: (i, n) => this.progress(base + span * (i / n), i === n - 1 ? "Confirm the update on your device..." : `Installing OSU ${i}/${n}`)
    });
  }
  flashMcuOrBootloader(targetId, version, label, base, span) {
    this.log(`Flashing ${label} ${version} (bootloader targetId 0x${targetId.toString(16)})...`, "warning");
    this.log("DO NOT unplug the device.", "warning");
    return this.runSocket(this.socketUrl("mcu", { targetId, version }), {
      unresponsiveExpectedDuringBulk: true,
      rebootExpectedAtEndOfBulk: true,
      onProgress: (i, n) => this.progress(base + span * (i / n), `Flashing ${label} ${i}/${n}`)
    });
  }
  installFinal(targetId, final, base, span) {
    this.log(`Installing final firmware ${final.name || final.version}...`, "info");
    return this.runSocket(this.socketUrl("install", {
      targetId,
      perso: final.perso,
      firmware: final.firmware,
      firmwareKey: final.firmware_key
    }), {
      unresponsiveExpectedDuringBulk: true,
      rebootExpectedAtEndOfBulk: true,
      onProgress: (i, n) => this.progress(base + span * (i / n), `Installing firmware ${i}/${n}`)
    });
  }
  // ---- full update (updateFirmwareTask + firmwareUpdate-main) ----
  /**
   * @param {object} ctx - result of getLatestFirmware()
   * @returns {object} device info after the update
   */
  async update(ctx) {
    const { osu, final, shouldFlashMCU, mcus } = ctx;
    const cfg = this.cfg;
    let info = await this.getDeviceInfo();
    if (info.isBootloader || info.isOSU) {
      throw new FirmwareError("DeviceOnDashboardExpected", "Device must be on the dashboard (not bootloader / OSU)");
    }
    this.log(`Firmware update ${info.version} -> ${ctx.targetVersion}` + (shouldFlashMCU ? " (MCU update required)" : " (SE only)"), "warning");
    this.progress(2, "Installing OSU...");
    await this.installOsu(info.targetId, osu, 2, 40);
    this.log("OSU installed, device is rebooting...", "success");
    this.progress(42, "Device rebooting...");
    info = await this.waitForDevice("Your Ledger rebooted after the OSU step. Plug it back / unlock it, then reconnect.");
    if (shouldFlashMCU) {
      if (!info.isBootloader) {
        throw new FirmwareError(
          "DeviceOnBootloaderExpected",
          `Expected the device in bootloader mode, got ${info.rawVersion}. Unplug it and plug it back holding the left button, then use Bootloader Recovery.`
        );
      }
      let repetitions = 0;
      while (info.isBootloader) {
        if (repetitions > cfg.maxFlashRepetitions) {
          throw new FirmwareError("TooManyMcuOrBootloaderFlashes", "Still in bootloader after too many flashes");
        }
        const mcuVersion = this.retrieveMcuVersion(final, mcus);
        if (!mcuVersion) throw new FirmwareError("McuVersionNotFound", "No MCU found for this firmware on this provider");
        const { bootloaderVersion, isMcuUpdate } = getFlashMcuOrBootloaderDetails(info.majMin, mcuVersion.from_bootloader_version);
        const version = isMcuUpdate ? mcuVersion.name : bootloaderVersion;
        const base = 45 + repetitions * 10;
        await this.flashMcuOrBootloader(info.targetId, version, isMcuUpdate ? "MCU" : "bootloader", base, 10);
        this.log(`${isMcuUpdate ? "MCU" : "Bootloader"} ${version} flashed, device rebooting...`, "success");
        info = await this.waitForDevice("Your Ledger rebooted after the MCU step. Reconnect it.");
        repetitions++;
      }
    }
    if (final && final.firmware) {
      if (!info.isOSU) {
        throw new FirmwareError("DeviceInOSUExpected", `Expected the device in OSU mode, got ${info.rawVersion}`);
      }
      this.progress(85, "Installing final firmware...");
      await this.installFinal(info.targetId, final, 85, 12);
      info = await this.waitForDevice("Your Ledger rebooted with the new firmware. Unlock it and reconnect.");
    } else if (info.isOSU) {
      this.log("Device still reports OSU, waiting for it to finish...", "info");
      info = await this.waitForDevice("Your Ledger is finishing the update. Unlock it and reconnect.");
    }
    this.progress(100, `Firmware ${info.version}`);
    this.log(`Firmware update complete: ${info.version} (MCU ${info.mcuVersion})`, "success");
    return info;
  }
  // ---- bootloader recovery (firmwareUpdate-repair, default branch) ----
  /**
   * Device stuck in bootloader mode (plug it holding the left button).
   * Flashes the bootloader then the MCU matching the SE firmware the device reports,
   * exactly like Ledger Live's "repair". Loops until the device leaves bootloader mode.
   */
  async repair() {
    const cfg = this.cfg;
    let info = await this.getDeviceInfo();
    if (!info.isBootloader) {
      this.log(`Device reports ${info.rawVersion} (${info.model}), not the bootloader: nothing to repair. To force bootloader mode, unplug the device and plug it back while holding the left button.`, "warning");
      return info;
    }
    this.log(`Bootloader ${info.mcuBlVersion} (targetId 0x${info.targetId.toString(16)}), SE ${info.seVersion || "?"} (targetId ${info.seTargetId ? "0x" + info.seTargetId.toString(16) : "?"})`, "info");
    const mcus = await this.api("mcu_versions");
    const available = mcus.filter((m) => m.providers.includes(this.provider) && m.from_bootloader_version !== "none");
    let repetitions = 0;
    while (info.isBootloader) {
      if (repetitions > cfg.maxFlashRepetitions) {
        throw new FirmwareError("TooManyMcuOrBootloaderFlashes", "Still in bootloader after too many flashes");
      }
      let version;
      if (info.seVersion && info.seTargetId) {
        const finalFirmware = await this.finalFirmwareForSe(info.seTargetId, info.seVersion);
        const mcu = findBestMCU(available.filter((m) => finalFirmware.mcu_versions.includes(m.id)));
        if (!mcu) throw new FirmwareError("McuVersionNotFound", `No MCU for SE ${info.seVersion}`);
        const expected = coerce(mcu.from_bootloader_version).join(".");
        const current = coerce(info.mcuBlVersion).join(".");
        version = expected === current ? mcu.name : expected;
        this.log(`SE ${info.seVersion} wants MCU ${mcu.name} on bootloader ${expected}; current bootloader ${current}: flashing ${version}`, "info");
      } else {
        const current = coerce(info.mcuBlVersion).join(".");
        const mcu = findBestMCU(available.filter((m) => coerce(m.from_bootloader_version).join(".") === current));
        if (!mcu) throw new FirmwareError("McuVersionNotFound", `No MCU compatible with bootloader ${info.rawVersion}`);
        version = mcu.name;
        this.log(`No SE info from bootloader ${current}: flashing MCU ${version}`, "info");
      }
      await this.flashMcuOrBootloader(info.targetId, version, "MCU/bootloader", 10 + repetitions * 20, 20);
      info = await this.waitForDevice("Your Ledger rebooted. Reconnect it (hold the left button while plugging it if it is still in bootloader).");
      repetitions++;
    }
    if (info.isOSU) {
      this.log(`Secure Element is on OSU ${info.rawVersion}: finishing the update`, "warning");
      const ctx = await this.getLatestFirmware(info);
      if (ctx && ctx.final && ctx.final.firmware) {
        await this.installFinal(info.targetId, ctx.final, 85, 12);
      }
      info = await this.waitForDevice("Your Ledger is finishing the update. Unlock it and reconnect.");
    }
    this.progress(100, "Recovered");
    this.log(`Device recovered: firmware ${info.version}, MCU ${info.mcuVersion}`, "success");
    return info;
  }
  /**
   * Final-firmware record (with its mcu_versions) for the SE version a bootloader reports.
   * The SE may report "x.y.z-osu" when the update was interrupted after the OSU step: the
   * manager API knows that one under get_osu_version, whose next_se_firmware_final_version
   * is the firmware the MCU must match.
   */
  async finalFirmwareForSe(seTargetId, seVersion) {
    const provider = this.provider;
    const deviceVersion = await this.api("get_device_version", { provider, target_id: seTargetId });
    const isOSU = seVersion.includes("-osu");
    const version = seVersion.replace("-osu", "");
    if (!isOSU) {
      try {
        return await this.api("get_firmware_version", { device_version: deviceVersion.id, version_name: version, provider });
      } catch (e) {
        this.log(`get_firmware_version(${version}) failed (${e.message}), trying the OSU record`, "warning");
      }
    }
    const osu = await this.api("get_osu_version", { device_version: deviceVersion.id, version_name: `${version}-osu`, provider });
    return this.api(`firmware_final_versions/${osu.next_se_firmware_final_version}`);
  }
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isDisconnect(err2) {
  const m = String(err2 && err2.message || "").toLowerCase();
  return m.includes("disconnect") || m.includes("timeout") || m.includes("not opened") || m.includes("failed to write");
}
function mapFirmwareStatus(err2) {
  if (!(err2 instanceof CommException)) return err2;
  switch (err2.sw) {
    case 27268:
    case 20739:
      return new FirmwareError("NotEnoughSpace", "Not enough space on device for the firmware");
    case 27269:
    case 20738:
    case 27013:
    case 21761:
      return new FirmwareError("UserRefusedFirmwareUpdate", "Update refused on device");
    default:
      return err2;
  }
}

// src/firmwareUi.js
var GET_VERSION = new Uint8Array([224, 1, 0, 0, 0]);
var FirmwareUi = class {
  constructor(opts) {
    this.getTransport = opts.getTransport;
    this.setTransport = opts.setTransport;
    this.log = opts.log || (() => {
    });
    this.progress = opts.progress || (() => {
    });
    this.showProgress = opts.showProgress || (() => {
    });
    this.onDeviceInfo = opts.onDeviceInfo || (() => {
    });
    this.config = opts.config || {};
    this.buttons = {
      firmware: "firmwareBtn",
      recovery: "recoveryBtn",
      lockWhileUpdating: ["connectBtn", "refreshBtn", "genuineBtn"],
      ...opts.buttons || {}
    };
    this.labels = {
      check: "\u{1F4E6} Check Firmware",
      update: "\u2B06\uFE0F Update Firmware",
      recovery: "\u{1F6E0}\uFE0F Bootloader Recovery",
      ...opts.labels || {}
    };
    this.updateContext = null;
  }
  el(id) {
    return document.getElementById(id);
  }
  mount() {
    const fwBtn = this.el(this.buttons.firmware);
    if (fwBtn) fwBtn.onclick = () => this.check();
    const recBtn = this.el(this.buttons.recovery);
    if (recBtn) recBtn.onclick = () => this.recover();
    return this;
  }
  /** Call on (re)connect: forgets any pending update and resets the button. */
  reset() {
    this.updateContext = null;
    this.setFirmwareButton("check", false);
  }
  setFirmwareButton(mode, disabled = false) {
    const btn = this.el(this.buttons.firmware);
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList.toggle("warning", mode === "update");
    btn.classList.toggle("secondary", mode !== "update");
    btn.textContent = mode === "update" ? this.labels.update : this.labels.check;
    btn.onclick = mode === "update" ? () => this.update() : () => this.check();
  }
  setBusy(btnId, text) {
    const btn = this.el(btnId);
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<span class="loading"></span>${text}`;
  }
  lock(locked) {
    for (const id of this.buttons.lockWhileUpdating) {
      const b = this.el(id);
      if (b) b.disabled = locked;
    }
  }
  makeUpdater() {
    return new FirmwareUpdater({
      transport: this.getTransport(),
      reconnect: (message, kind) => this.showReconnectModal(message, kind),
      onLog: this.log,
      onProgress: this.progress,
      onEvent: (name) => {
        if (name === "allowSecureChannelRequested") this.log("Allow the secure channel on your device", "warning");
        if (name === "devicePermissionRequested") this.log("Confirm the firmware update on your device", "warning");
      },
      config: this.config
    });
  }
  async refreshDeviceInfo(updater) {
    this.setTransport(updater.transport);
    const info = await updater.getDeviceInfo();
    this.onDeviceInfo(info);
    return info;
  }
  // ---- actions ----
  async check() {
    this.setBusy(this.buttons.firmware, "Checking...");
    this.showProgress(true);
    this.progress(20, "Querying Ledger servers...");
    try {
      const updater = this.makeUpdater();
      const info = await updater.getDeviceInfo();
      if (info.isBootloader) {
        this.log("Device is in bootloader mode: use Bootloader Recovery", "warning");
        return;
      }
      const ctx = await updater.getLatestFirmware(info);
      this.progress(100, ctx ? "Update available!" : "Firmware is up to date!");
      if (!ctx) {
        this.updateContext = null;
        this.log(`\u2713 Firmware ${info.version} is up to date`, "success");
        return;
      }
      this.updateContext = ctx;
      this.log(`\u26A0\uFE0F FIRMWARE UPDATE AVAILABLE: ${ctx.currentVersion} \u2192 ${ctx.targetVersion}`, "warning");
      this.log(ctx.shouldFlashMCU ? `MCU ${info.mcuVersion} must also be flashed (device will pass through bootloader mode)` : `Secure Element only (MCU ${info.mcuVersion} is compatible)`, "info");
      this.log('Click "Update Firmware" to start. Keep the device plugged in for the whole process.', "info");
    } catch (error) {
      console.error("Firmware check error:", error);
      this.log(`Firmware check failed: ${error.message}`, "error");
      this.progress(0, "Check failed");
    } finally {
      this.setFirmwareButton(this.updateContext ? "update" : "check");
      setTimeout(() => this.showProgress(false), 2e3);
    }
  }
  async update() {
    if (!this.updateContext) {
      this.log("No firmware update available. Check first.", "error");
      return;
    }
    const ctx = this.updateContext;
    this.setBusy(this.buttons.firmware, "Updating...");
    this.lock(true);
    this.showProgress(true);
    try {
      this.log("\u26A0\uFE0F DO NOT unplug your device during the update, even when the screen goes blank.", "warning");
      const updater = this.makeUpdater();
      await updater.update(ctx);
      const info = await this.refreshDeviceInfo(updater);
      this.updateContext = null;
      this.log(`\u2713 Device now on firmware ${info.version}`, "success");
    } catch (error) {
      console.error("Firmware update error:", error);
      this.log(`Firmware update failed: ${error.message}`, "error");
      this.log('If the device shows "Bootloader", unplug it, plug it back holding the left button and use Bootloader Recovery.', "warning");
      this.progress(0, "Update failed");
    } finally {
      this.lock(false);
      this.setFirmwareButton(this.updateContext ? "update" : "check");
      setTimeout(() => this.showProgress(false), 3e3);
    }
  }
  async recover() {
    this.setBusy(this.buttons.recovery, "Recovering...");
    this.showProgress(true);
    this.progress(5, "Connecting to device in bootloader mode...");
    try {
      this.log("\u{1F6E0}\uFE0F Bootloader recovery: flashing bootloader/MCU matching the firmware on the Secure Element", "warning");
      let transport = this.getTransport();
      let probeOk = false;
      if (transport && transport.opened) {
        try {
          await transport.exchange(GET_VERSION);
          probeOk = true;
        } catch (e) {
          probeOk = false;
        }
      }
      if (!probeOk) {
        if (transport) {
          try {
            await transport.close();
          } catch (e) {
          }
        }
        transport = await TransportWebHID.request(true);
        this.setTransport(transport);
      }
      this.log(`GET_VERSION: ${bytesToHex3(await transport.exchange(GET_VERSION))}`, "info");
      const updater = this.makeUpdater();
      await updater.repair();
      const info = await this.refreshDeviceInfo(updater);
      this.log(`\u2713 Device recovered: ${info.version}`, "success");
    } catch (error) {
      console.error("Recovery error:", error);
      this.log(`Recovery failed: ${error.message}`, "error");
      this.progress(0, "Recovery failed");
    } finally {
      const btn = this.el(this.buttons.recovery);
      if (btn) {
        btn.disabled = false;
        btn.textContent = this.labels.recovery;
      }
      setTimeout(() => this.showProgress(false), 5e3);
    }
  }
  // ---- reconnect modal: WebHID needs a user gesture to pair the re-enumerated device ----
  showReconnectModal(message, kind = "usb") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "zknox-reconnect-overlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999;";
      const modal = document.createElement("div");
      modal.style.cssText = "background:#0a0a0f;border:1px solid rgba(167,139,250,0.3);border-radius:16px;padding:30px;text-align:center;max-width:420px;";
      const title = document.createElement("h3");
      title.style.cssText = "color:#fff;margin:0 0 15px 0;";
      title.textContent = "\u{1F50C} Reconnect Device";
      const text = document.createElement("p");
      text.style.cssText = "color:#a78bfa;margin:0 0 20px 0;";
      text.textContent = message;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";
      const mkBtn = (label, request) => {
        const btn = document.createElement("button");
        btn.style.cssText = "background:#238636;color:#fff;border:none;padding:12px 24px;border-radius:6px;font-size:16px;cursor:pointer;";
        btn.textContent = label;
        btn.onclick = async () => {
          for (const b of row.children) b.disabled = true;
          btn.textContent = "Connecting...";
          try {
            const t = await request();
            document.body.removeChild(overlay);
            resolve(t);
          } catch (e) {
            for (const b of row.children) b.disabled = false;
            btn.textContent = label;
            text.textContent = `Connection failed: ${e.message}. ${message}`;
          }
        };
        return btn;
      };
      const usb = mkBtn("\u{1F50C} Reconnect USB", () => TransportWebHID.request(true));
      row.appendChild(usb);
      if (TransportWebBLE.isSupported()) {
        const ble = mkBtn("\u{1F4F6} Reconnect Bluetooth", () => TransportWebBLE.request(true));
        if (kind === "ble") {
          row.insertBefore(ble, usb);
        } else {
          row.appendChild(ble);
        }
      }
      modal.append(title, text, row);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }
};
export {
  BLE_MODELS,
  CURVES,
  DIR_ARTIFACT_FILES,
  FIRMWARE_DEFAULTS,
  FirmwareError,
  FirmwareUi,
  FirmwareUpdater,
  HexLoader,
  IntelHexParser,
  IntelHexPrinter,
  PrivateKey,
  PublicKey,
  TARGET_DIRS,
  TARGET_IDS,
  TARGET_NAMES,
  TransportMock,
  TransportWebBLE,
  TransportWebHID,
  bytesToHex3 as bytesToHex,
  deleteApp,
  describeApduScript,
  fetchCatalogApp,
  findBestMCU,
  getDeployedSecretV1,
  getDeployedSecretV2,
  getDeviceInfo,
  getDeviceModelName,
  getFlashMcuOrBootloaderDetails,
  getMemInfo,
  hexToBytes2 as hexToBytes,
  listApps,
  loadApp,
  parseApduScript,
  parseArtifactManifest,
  parseBip32Path,
  parseGetVersion,
  replayApduScript,
  resolveCatalogFiles,
  targetDir
};
/*! Bundled license information:

@noble/secp256k1/index.js:
  (*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

@noble/hashes/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
/*! Bundled license information:

@noble/secp256k1/index.js:
  (*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

@noble/hashes/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
