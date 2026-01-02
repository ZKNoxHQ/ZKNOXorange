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
    20767: "The OS version on your device does not seem compatible with the SDK version used to build the app",
    20768: "Sideload is not supported on Nano X",
    25873: "Device is not in Recovery Mode - boot while holding button",
    25874: "Device locked or not in right state",
    22279: "SCP certificate validation failed - check custom CA installation",
    26115: "SCP mutual authentication failed - certificate chain rejected"
  };
  return causeMap[sw] || "Unknown reason";
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
      const data = hexToBytes(line.slice(1));
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
    const hexStr = bytesToHex(bin).toUpperCase();
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
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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
function splitIntoPackets(wrapped, packetSize = 64) {
  const packets = [];
  for (let i = 0; i < wrapped.length; i += packetSize) {
    packets.push(wrapped.slice(i, i + packetSize));
  }
  return packets;
}
function combinePackets(packets) {
  const totalLength = packets.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const packet of packets) {
    result.set(packet, offset);
    offset += packet.length;
  }
  return result;
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
var err = (m = "") => {
  throw new Error(m);
};
var isBig = (n) => typeof n === "bigint";
var isStr = (s) => typeof s === "string";
var isBytes = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
var abytes = (a, l) => !isBytes(a) || typeof l === "number" && l > 0 && a.length !== l ? err("Uint8Array expected") : a;
var u8n = (len) => new Uint8Array(len);
var u8fr = (buf) => Uint8Array.from(buf);
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
var hexToBytes2 = (hex) => {
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
var toU8 = (a, len) => abytes(isStr(a) ? hexToBytes2(a) : u8fr(abytes(a)), len);
var cr = () => globalThis?.crypto;
var subtle = () => cr()?.subtle ?? err("crypto.subtle must be defined");
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
  const fn = etc[name];
  if (typeof fn !== "function")
    err("hashes." + name + " not set");
  return fn;
};
var apoint = (p) => p instanceof Point ? p : err("Point expected");
var koblitz = (x) => M(M(x * x) * x + _b);
var afield0 = (n) => arange(n, 0n, P);
var afield = (n) => arange(n, 1n, P);
var agroup = (n) => arange(n, 1n, N);
var isEven = (y) => (y & 1n) === 0n;
var u8of = (n) => Uint8Array.of(n);
var getPrefix = (y) => u8of(isEven(y) ? 2 : 3);
var lift_x = (x) => {
  const c = koblitz(afield(x));
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
  px;
  py;
  pz;
  constructor(px, py, pz) {
    this.px = afield0(px);
    this.py = afield(py);
    this.pz = afield0(pz);
    Object.freeze(this);
  }
  /** Convert Uint8Array or hex string to Point. */
  static fromBytes(bytes) {
    abytes(bytes);
    let p = void 0;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    const x = sliceBytesNumBE(tail, 0, L);
    const len = bytes.length;
    if (len === L + 1 && [2, 3].includes(head)) {
      let y = lift_x(x);
      const evenY = isEven(y);
      const evenH = isEven(big(head));
      if (evenH !== evenY)
        y = M(-y);
      p = new _Point(x, y, 1n);
    }
    if (len === L2 + 1 && head === 4)
      p = new _Point(x, sliceBytesNumBE(tail, L, L2), 1n);
    return p ? p.assertValidity() : err("bad point: not on curve");
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { px: X1, py: Y1, pz: Z1 } = this;
    const { px: X2, py: Y2, pz: Z2 } = apoint(other);
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
    return new _Point(this.px, M(-this.py), this.pz);
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
    const { px: X1, py: Y1, pz: Z1 } = this;
    const { px: X2, py: Y2, pz: Z2 } = apoint(other);
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
    agroup(n);
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
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { px: x, py: y, pz: z } = this;
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
    afield(x);
    afield(y);
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
  /** Create 3d xyz point from 2d xy. (0, 0) => (0, 1, 0), not (0, 0, 1) */
  static fromAffine(ap) {
    const { x, y } = ap;
    return x === 0n && y === 0n ? I : new _Point(x, y, 1n);
  }
  toHex(isCompressed) {
    return bytesToHex2(this.toBytes(isCompressed));
  }
  static fromPrivateKey(k) {
    return G.multiply(toPrivScalar(k));
  }
  static fromHex(hex) {
    return _Point.fromBytes(toU8(hex));
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  toRawBytes(isCompressed) {
    return this.toBytes(isCompressed);
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
var numTo32b = (num) => hexToBytes2(padh(arange(num, 0n, B256), L2));
var toPrivScalar = (pr) => {
  const num = isBig(pr) ? pr : bytesToNumBE(toU8(pr, L));
  return arange(num, 1n, N, "private key invalid 3");
};
var highS = (n) => n > N >> 1n;
var getPublicKey = (privKey, isCompressed = true) => {
  return G.multiply(toPrivScalar(privKey)).toBytes(isCompressed);
};
var Signature = class _Signature {
  r;
  s;
  recovery;
  constructor(r, s, recovery) {
    this.r = agroup(r);
    this.s = agroup(s);
    if (recovery != null)
      this.recovery = recovery;
    Object.freeze(this);
  }
  /** Create signature from 64b compact (r || s) representation. */
  static fromBytes(b) {
    abytes(b, L2);
    const r = sliceBytesNumBE(b, 0, L);
    const s = sliceBytesNumBE(b, L, L2);
    return new _Signature(r, s);
  }
  toBytes() {
    const { r, s } = this;
    return concatBytes(numTo32b(r), numTo32b(s));
  }
  /** Copy signature, with newly added recovery bit. */
  addRecoveryBit(bit) {
    return new _Signature(this.r, this.s, bit);
  }
  hasHighS() {
    return highS(this.s);
  }
  toCompactRawBytes() {
    return this.toBytes();
  }
  toCompactHex() {
    return bytesToHex2(this.toBytes());
  }
  recoverPublicKey(msg) {
    return recoverPublicKey(this, msg);
  }
  static fromCompact(hex) {
    return _Signature.fromBytes(toU8(hex, L2));
  }
  assertValidity() {
    return this;
  }
  normalizeS() {
    const { r, s, recovery } = this;
    return highS(s) ? new _Signature(r, modN(-s), recovery) : this;
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
var signOpts = { lowS: true };
var veriOpts = { lowS: true };
var prepSig = (msgh, priv, opts = signOpts) => {
  if (["der", "recovered", "canonical"].some((k) => k in opts))
    err("option not supported");
  let { lowS, extraEntropy } = opts;
  if (lowS == null)
    lowS = true;
  const i2o = numTo32b;
  const h1i = bits2int_modN(toU8(msgh));
  const h1o = i2o(h1i);
  const d = toPrivScalar(priv);
  const seed = [i2o(d), h1o];
  if (extraEntropy)
    seed.push(extraEntropy === true ? randomBytes(L) : toU8(extraEntropy));
  const m = h1i;
  const k2sig = (kBytes) => {
    const k = bits2int(kBytes);
    if (!(1n <= k && k < N))
      return;
    const q = G.multiply(k).toAffine();
    const r = modN(q.x);
    if (r === 0n)
      return;
    const ik = invert(k, N);
    const s = modN(ik * modN(m + modN(d * r)));
    if (s === 0n)
      return;
    let normS = s;
    let recovery = (q.x === r ? 0 : 2) | Number(q.y & 1n);
    if (lowS && highS(s)) {
      normS = modN(-s);
      recovery ^= 1;
    }
    return new Signature(r, normS, recovery);
  };
  return { seed: concatBytes(...seed), k2sig };
};
var hmacDrbg = (asynchronous) => {
  let v = u8n(L);
  let k = u8n(L);
  let i = 0;
  const NULL = u8n(0);
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const max = 1e3;
  const _e = "drbg: tried 1000 values";
  if (asynchronous) {
    const h = (...b) => etc.hmacSha256Async(k, v, ...b);
    const reseed = async (seed = NULL) => {
      k = await h(u8of(0), seed);
      v = await h();
      if (seed.length === 0)
        return;
      k = await h(u8of(1), seed);
      v = await h();
    };
    const gen = async () => {
      if (i++ >= max)
        err(_e);
      v = await h();
      return v;
    };
    return async (seed, pred) => {
      reset();
      await reseed(seed);
      let res = void 0;
      while (!(res = pred(await gen())))
        await reseed();
      reset();
      return res;
    };
  } else {
    const h = (...b) => callHash("hmacSha256Sync")(k, v, ...b);
    const reseed = (seed = NULL) => {
      k = h(u8of(0), seed);
      v = h();
      if (seed.length === 0)
        return;
      k = h(u8of(1), seed);
      v = h();
    };
    const gen = () => {
      if (i++ >= max)
        err(_e);
      v = h();
      return v;
    };
    return (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while (!(res = pred(gen())))
        reseed();
      reset();
      return res;
    };
  }
};
var sign = (msgh, priv, opts = signOpts) => {
  const { seed, k2sig } = prepSig(msgh, priv, opts);
  const sig = hmacDrbg(false)(seed, k2sig);
  return sig;
};
var verify = (sig, msgh, pub, opts = veriOpts) => {
  let { lowS } = opts;
  if (lowS == null)
    lowS = true;
  if ("strict" in opts)
    err("option not supported");
  let sigg;
  const rs = sig && typeof sig === "object" && "r" in sig;
  if (!rs && toU8(sig).length !== L2)
    err("signature must be 64 bytes");
  try {
    sigg = rs ? new Signature(sig.r, sig.s) : Signature.fromCompact(sig);
    const h = bits2int_modN(toU8(msgh));
    const P2 = Point.fromBytes(toU8(pub));
    const { r, s } = sigg;
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
var recoverPublicKey = (sig, msgh) => {
  const { r, s, recovery } = sig;
  if (![0, 1, 2, 3].includes(recovery))
    err("recovery id invalid");
  const h = bits2int_modN(toU8(msgh, L));
  const radj = recovery === 2 || recovery === 3 ? r + N : r;
  afield(radj);
  const head = getPrefix(big(recovery));
  const Rb = concatBytes(head, numTo32b(radj));
  const R = Point.fromBytes(Rb);
  const ir = invert(radj, N);
  const u1 = modN(-h * ir);
  const u2 = modN(s * ir);
  return doubleScalarMulUns(R, u1, u2);
};
var hashToPrivateKey = (hash) => {
  hash = toU8(hash);
  if (hash.length < L + 8 || hash.length > 1024)
    err("expected 40-1024b");
  const num = M(bytesToNumBE(hash), N - 1n);
  return numTo32b(num + 1n);
};
var randomPrivateKey = () => hashToPrivateKey(randomBytes(L + 16));
var _sha = "SHA-256";
var etc = {
  hexToBytes: hexToBytes2,
  bytesToHex: bytesToHex2,
  concatBytes,
  bytesToNumberBE: bytesToNumBE,
  numberToBytesBE: numTo32b,
  mod: M,
  invert,
  // math utilities
  hmacSha256Async: async (key, ...msgs) => {
    const s = subtle();
    const name = "HMAC";
    const k = await s.importKey("raw", key, { name, hash: { name: _sha } }, false, ["sign"]);
    return u8n(await s.sign(name, k, concatBytes(...msgs)));
  },
  hmacSha256Sync: void 0,
  // For TypeScript. Actual logic is below
  hashToPrivateKey,
  randomBytes
};
var utils = {
  normPrivateKeyToScalar: toPrivScalar,
  isValidPrivateKey: (key) => {
    try {
      return !!toPrivScalar(key);
    } catch (e) {
      return false;
    }
  },
  randomPrivateKey,
  precompute: (w = 8, p = G) => {
    p.multiply(3n);
    w;
    return p;
  }
};
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
  return { p, f };
};

// node_modules/@noble/hashes/esm/crypto.js
var crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// node_modules/@noble/hashes/esm/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes2(b, ...lengths) {
  if (!isBytes2(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
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
  abytes2(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
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
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes2(data);
  return data;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes2(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
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
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
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
    to || (to = new this.constructor());
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

// node_modules/@noble/hashes/esm/sha2.js
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
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
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
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());

// node_modules/@noble/hashes/esm/sha256.js
var sha2562 = sha256;

// node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes(_key);
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
    abytes2(out, this.outputLen);
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
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
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
var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

// src/ecWrapper.js
etc.hmacSha256Sync = (k, ...m) => hmac(sha2562, k, etc.concatBytes(...m));
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
function derToRS(der) {
  if (der[0] !== 48) throw new Error("Invalid DER signature");
  let offset = 2;
  if (der[offset] !== 2) throw new Error("Invalid DER signature");
  offset++;
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 2) throw new Error("Invalid DER signature");
  offset++;
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);
  return {
    r: bytesToBigInt(rBytes),
    s: bytesToBigInt(sBytes)
  };
}
var PublicKey = class {
  /**
   * @param {Uint8Array} pubkey - Public key bytes (65 bytes uncompressed with 0x04 prefix)
   * @param {boolean} raw - If true, pubkey is raw bytes
   */
  constructor(pubkey = null, raw = false) {
    if (pubkey === null) {
      this._point = null;
    } else if (raw) {
      this._pubkeyBytes = new Uint8Array(pubkey);
      if (pubkey[0] === 4 && pubkey.length === 65) {
        this._point = Point.fromHex(pubkey);
      } else if ((pubkey[0] === 2 || pubkey[0] === 3) && pubkey.length === 33) {
        this._point = Point.fromHex(pubkey);
      } else {
        throw new Error("Invalid public key format");
      }
    } else {
      throw new Error("Non-raw init not supported");
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
    return new Signature(r, s);
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
      data = sharedPoint.toRawBytes(true);
      console.log("ECDH: Using COMPRESSED POINT format (33 bytes):", bytesToHex3(data));
    } else {
      const xBytes = bigIntToBytes(sharedPoint.x, 32);
      data = new Uint8Array(36);
      data.set(xBytes, 0);
      data[32] = 0;
      data[33] = 0;
      data[34] = 0;
      data[35] = 1;
      console.log("ECDH: Using X+COUNTER format (36 bytes):", bytesToHex3(data));
    }
    const result = sha2562(data);
    console.log("ECDH: Secret (SHA256):", bytesToHex3(result));
    return result;
  }
  /**
   * Tweak the public key by adding a scalar * G
   * @param {Uint8Array} scalar - Scalar to add
   */
  tweakAdd(scalar) {
    const scalarBigInt = bytesToBigInt(scalar);
    const tweakPoint = Point.BASE.multiply(scalarBigInt);
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
  ecdsaVerify(msg, rawSig, raw = false, digest = sha2562) {
    let msgHash;
    if (raw) {
      msgHash = msg;
    } else {
      msgHash = digest(msg);
    }
    let sig;
    if (rawSig instanceof Signature) {
      sig = rawSig;
    } else if (rawSig instanceof Uint8Array) {
      sig = this.ecdsaDeserialize(rawSig);
    } else {
      sig = rawSig;
    }
    const pubkeyBytes = this._point.toRawBytes(false);
    return verify(sig, msgHash, pubkeyBytes);
  }
};
var PrivateKey = class {
  /**
   * @param {Uint8Array|null} privkey - Private key bytes (32 bytes) or null to generate
   * @param {boolean} raw - Must be true
   */
  constructor(privkey = null, raw = true) {
    if (!raw) {
      throw new Error("Non-raw init not supported");
    }
    if (privkey === null) {
      this._privateKey = utils.randomPrivateKey();
    } else {
      this._privateKey = new Uint8Array(privkey);
    }
    const pubkeyBytes = getPublicKey(this._privateKey, false);
    this.pubkey = new PublicKey(pubkeyBytes, true);
  }
  /**
   * Serialize the private key as hex string
   * @returns {string}
   */
  serialize() {
    return bytesToHex3(this._privateKey);
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
    if (rawSig && typeof rawSig.toCompactRawBytes === "function") {
      const compact = rawSig.toCompactRawBytes();
      return compactToDER(compact);
    }
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
  ecdsaSign(msg, raw = false, digest = sha2562, rfc6979 = false) {
    let msgHash;
    if (raw) {
      msgHash = msg;
    } else {
      msgHash = digest(msg);
    }
    const sig = sign(msgHash, this._privateKey);
    return sig;
  }
};
function bytesToBigInt(bytes) {
  let result = 0n;
  for (const byte of bytes) {
    result = result << 8n | BigInt(byte);
  }
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
function hexToBytes3(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// src/deployed.js
async function getDeployedSecretV1(dongle, masterPrivate, targetId) {
  const testMaster = new PrivateKey(masterPrivate);
  const testMasterPublic = testMaster.pubkey.serialize(false);
  const targetIdBytes = uint32ToBytes(targetId);
  if ((targetId & 15) !== 1) {
    throw new Error("Target ID does not support SCP V1");
  }
  let apdu = new Uint8Array([224, 4, 0, 0, targetIdBytes.length, ...targetIdBytes]);
  await dongle.exchange(apdu);
  const batchInfo = await dongle.exchange(hexToBytes3("e050000000"));
  const cardKeyLen = batchInfo[4];
  const cardKey = batchInfo.slice(5, 5 + cardKeyLen);
  const ephemeralPrivate = new PrivateKey();
  const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
  console.log("Using ephemeral key " + bytesToHex3(ephemeralPublic));
  const signature = testMaster.ecdsaSign(ephemeralPublic);
  const signatureDer = testMaster.ecdsaSerialize(signature);
  const certificate = new Uint8Array([
    ephemeralPublic.length,
    ...ephemeralPublic,
    signatureDer.length,
    ...signatureDer
  ]);
  apdu = new Uint8Array([224, 81, 0, 0, certificate.length, ...certificate]);
  await dongle.exchange(apdu);
  let lastPubKey = new PublicKey(testMasterPublic, true);
  let index = 0;
  while (true) {
    const certResponse = await dongle.exchange(hexToBytes3("e052000000"));
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
        console.log("Broken certificate chain - loading from user key");
      } else {
        throw new Error("Broken certificate chain");
      }
    }
    lastPubKey = new PublicKey(certPublic, true);
    index++;
  }
  await dongle.exchange(hexToBytes3("e053000000"));
  const ephemeralPrivBytes = hexToBytes3(ephemeralPrivate.serialize());
  const secret = lastPubKey.ecdh(ephemeralPrivBytes);
  return secret.slice(0, 16);
}
async function getDeployedSecretV2(dongle, masterPrivate, targetId, signerCertChain = null, ecdhSecretFormat = null) {
  const testMaster = new PrivateKey(masterPrivate);
  const testMasterPublic = testMaster.pubkey.serialize(false);
  const targetIdBytes = uint32ToBytes(targetId);
  if ((targetId & 15) < 2) {
    throw new Error("Target ID does not support SCP V2");
  }
  console.log("SCP: Sending IDENTIFY (E004)");
  let apdu = new Uint8Array([224, 4, 0, 0, targetIdBytes.length, ...targetIdBytes]);
  console.log("SCP: APDU =", bytesToHex3(apdu));
  let response = await dongle.exchange(apdu);
  console.log("SCP: Response =", bytesToHex3(response));
  const nonce = randomBytes2(8);
  console.log("SCP: Sending GET_NONCE (E050) with nonce =", bytesToHex3(nonce));
  apdu = new Uint8Array([224, 80, 0, 0, nonce.length, ...nonce]);
  console.log("SCP: APDU =", bytesToHex3(apdu));
  const authInfo = await dongle.exchange(apdu);
  console.log("SCP: Response (authInfo) =", bytesToHex3(authInfo));
  const batchSignerSerial = authInfo.slice(0, 4);
  const deviceNonce = authInfo.slice(4, 12);
  console.log("SCP: batchSignerSerial =", bytesToHex3(batchSignerSerial));
  console.log("SCP: deviceNonce =", bytesToHex3(deviceNonce));
  if (signerCertChain) {
    for (const cert of signerCertChain) {
      apdu = new Uint8Array([224, 81, 0, 0, cert.length, ...cert]);
      await dongle.exchange(apdu);
    }
  } else {
    console.log("SCP: Using test master key =", bytesToHex3(testMasterPublic));
    const dataToSign = new Uint8Array([1, ...testMasterPublic]);
    console.log("SCP: Master cert data to sign =", bytesToHex3(dataToSign));
    const signature = testMaster.ecdsaSign(dataToSign);
    const signatureDer = testMaster.ecdsaSerialize(signature);
    console.log("SCP: Master cert signature (DER) =", bytesToHex3(signatureDer));
    const certificate = new Uint8Array([
      testMasterPublic.length,
      ...testMasterPublic,
      signatureDer.length,
      ...signatureDer
    ]);
    console.log("SCP: Master certificate =", bytesToHex3(certificate));
    console.log("SCP: Sending VALIDATE_CERT (E051) for master cert");
    apdu = new Uint8Array([224, 81, 0, 0, certificate.length, ...certificate]);
    console.log("SCP: APDU =", bytesToHex3(apdu));
    response = await dongle.exchange(apdu);
    console.log("SCP: Response =", bytesToHex3(response));
  }
  const ephemeralPrivate = new PrivateKey();
  const ephemeralPublic = ephemeralPrivate.pubkey.serialize(false);
  console.log("SCP: Using ephemeral key =", bytesToHex3(ephemeralPublic));
  const ephDataToSign = new Uint8Array([
    17,
    ...nonce,
    ...deviceNonce,
    ...ephemeralPublic
  ]);
  console.log("SCP: Ephemeral cert data to sign =", bytesToHex3(ephDataToSign));
  const ephSignature = testMaster.ecdsaSign(ephDataToSign);
  const ephSignatureDer = testMaster.ecdsaSerialize(ephSignature);
  console.log("SCP: Ephemeral cert signature (DER) =", bytesToHex3(ephSignatureDer));
  const ephCertificate = new Uint8Array([
    ephemeralPublic.length,
    ...ephemeralPublic,
    ephSignatureDer.length,
    ...ephSignatureDer
  ]);
  console.log("SCP: Ephemeral certificate =", bytesToHex3(ephCertificate));
  console.log("SCP: Sending VALIDATE_CERT (E051 P1=0x80) for ephemeral cert");
  apdu = new Uint8Array([224, 81, 128, 0, ephCertificate.length, ...ephCertificate]);
  console.log("SCP: APDU =", bytesToHex3(apdu));
  response = await dongle.exchange(apdu);
  console.log("SCP: Response =", bytesToHex3(response));
  let lastDevPubKey = new PublicKey(testMasterPublic, true);
  let devicePublicKey = null;
  let index = 0;
  while (true) {
    let certResponse;
    if (index === 0) {
      certResponse = await dongle.exchange(hexToBytes3("e052000000"));
    } else if (index === 1) {
      certResponse = await dongle.exchange(hexToBytes3("e052800000"));
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
      devicePublicKey = certPublicKey;
      certSignedData = new Uint8Array([2, ...certHeader, ...certPublicKey]);
    } else {
      certSignedData = new Uint8Array([18, ...deviceNonce, ...nonce, ...certPublicKey]);
    }
    if (!lastDevPubKey.ecdsaVerify(certSignedData, certSignature)) {
      if (index === 0) {
        console.log("Broken certificate chain - loading from user key");
      } else {
        throw new Error("Broken certificate chain");
      }
    }
    lastDevPubKey = new PublicKey(certPublicKey, true);
    index++;
  }
  await dongle.exchange(hexToBytes3("e053000000"));
  const ephemeralPrivBytes = hexToBytes3(ephemeralPrivate.serialize());
  console.log("SCP: Device ephemeral pubkey for ECDH:", bytesToHex3(lastDevPubKey.serialize(false)));
  console.log("SCP: Our ephemeral private key:", ephemeralPrivate.serialize());
  console.log("SCP: Using COMPRESSED POINT format (scpv3=false) to match Python");
  const secret = lastDevPubKey.ecdh(ephemeralPrivBytes, false);
  console.log("SCP: ECDH secret (raw):", bytesToHex3(secret));
  if (ecdhSecretFormat === 1 || (targetId & 15) === 2) {
    return secret.slice(0, 16);
  } else if ((targetId & 15) >= 3) {
    return {
      ecdh_secret: secret,
      devicePublicKey
    };
  }
  return secret.slice(0, 16);
}
function uint32ToBytes(value) {
  return new Uint8Array([
    value >> 24 & 255,
    value >> 16 & 255,
    value >> 8 & 255,
    value & 255
  ]);
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
      console.log("HID => " + bytesToHex4(apdu));
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
      console.log("HID <= " + bytesToHex4(data) + " SW=" + sw.toString(16).padStart(4, "0"));
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
      console.log("MOCK => " + bytesToHex4(apdu));
    }
    this.exchanges.push(new Uint8Array(apdu));
    let response;
    if (this.responseHandler) {
      response = await this.responseHandler(apdu);
    } else {
      response = new Uint8Array([144, 0]);
    }
    if (this.debug) {
      console.log("MOCK <= " + bytesToHex4(response));
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
  apduMaxDataSize() {
    return 255;
  }
};
async function getDongle(debug = false, mock = null) {
  if (mock) {
    return mock;
  }
  return TransportWebHID.openFirst(debug);
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
var BOLOS_TAG_DATASIZE = 5;
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
   * @param {boolean} scpv3 - Use SCP v3 format
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
      console.log("HexLoader: Got ecdh_secret object, using SCP v3 (with MAC)");
      const ecdhSecret = mutauthResult.ecdh_secret;
      console.log("HexLoader: ECDH secret:", bytesToHex5(ecdhSecret));
      this.scpEncKey = this._scpDeriveKeyV3(ecdhSecret, 0).slice(0, 16);
      console.log("HexLoader: SCP v3 ENC key:", bytesToHex5(this.scpEncKey));
      this.scpMacKey = this._scpDeriveKeyV3(ecdhSecret, 1).slice(0, 16);
      console.log("HexLoader: SCP v3 MAC key:", bytesToHex5(this.scpMacKey));
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
    const SECP256K1_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    let retry = 0;
    while (true) {
      const data = new Uint8Array(5 + ecdhSecret.length);
      data[0] = keyIndex >> 24 & 255;
      data[1] = keyIndex >> 16 & 255;
      data[2] = keyIndex >> 8 & 255;
      data[3] = keyIndex & 255;
      data[4] = retry;
      data.set(ecdhSecret, 5);
      const di = sha2562(data);
      const diBigInt = bytesToBigInt2(di);
      if (diBigInt < SECP256K1_ORDER) {
        const privkey = new PrivateKey(di);
        const Pi = privkey.pubkey.serialize(false);
        const ki = sha2562(Pi);
        console.log("HexLoader: Key derivation (keyIndex=" + keyIndex + "): ki=" + bytesToHex5(ki));
        return ki;
      }
      retry++;
      if (retry > 100) {
        throw new Error("Key derivation failed after 100 retries");
      }
    }
  }
  /**
   * Calculate CRC16-CCITT
   * @param {Uint8Array} data 
   * @returns {number}
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
   * Exchange APDU with optional SCP encryption
   * @param {number} cla 
   * @param {number} ins 
   * @param {number} p1 
   * @param {number} p2 
   * @param {Uint8Array} data 
   * @returns {Promise<Uint8Array>}
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
    if (this.card === null) {
      console.log(bytesToHex5(apdu));
      return new Uint8Array(0);
    }
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
    console.log("scpWrap input:", bytesToHex5(data));
    console.log("scpWrap scpVersion:", this.scpVersion);
    if (this.scpVersion === 3) {
      let paddedLen = data.length + 1;
      while (paddedLen % 16 !== 0) {
        paddedLen++;
      }
      const paddedData = new Uint8Array(paddedLen);
      paddedData.set(data);
      paddedData[data.length] = 128;
      console.log("scpWrap SCP v3 padded:", bytesToHex5(paddedData));
      console.log("scpWrap encKey:", bytesToHex5(this.scpEncKey));
      console.log("scpWrap encIv:", bytesToHex5(this.scpEncIv));
      const encryptedData = aesCbcEncryptNoPadding(this.scpEncKey, this.scpEncIv, paddedData);
      console.log("scpWrap encrypted:", bytesToHex5(encryptedData));
      this.scpEncIv = encryptedData.slice(-16);
      console.log("scpWrap macKey:", bytesToHex5(this.scpMacKey));
      console.log("scpWrap macIv:", bytesToHex5(this.scpMacIv));
      const macData = aesCbcEncryptNoPadding(this.scpMacKey, this.scpMacIv, encryptedData);
      this.scpMacIv = macData.slice(-16);
      console.log("scpWrap mac result:", bytesToHex5(this.scpMacIv));
      const result = new Uint8Array(encryptedData.length + SCP_MAC_LENGTH);
      result.set(encryptedData);
      result.set(this.scpMacIv.slice(-SCP_MAC_LENGTH), encryptedData.length);
      console.log("scpWrap final result:", bytesToHex5(result));
      return result;
    } else {
      console.log("scpWrap SCP v2 (no MAC)");
      console.log("scpWrap input:", bytesToHex5(data));
      let paddedLen = data.length + 1;
      while (paddedLen % 16 !== 0) {
        paddedLen++;
      }
      const paddedData = new Uint8Array(paddedLen);
      paddedData.set(data);
      paddedData[data.length] = 128;
      console.log("scpWrap padded:", bytesToHex5(paddedData));
      console.log("scpWrap key:", bytesToHex5(this.key));
      console.log("scpWrap iv:", bytesToHex5(this.iv));
      const encryptedData = await aesEncryptCBC(this.key, this.iv, paddedData);
      this.iv = encryptedData.slice(-16);
      console.log("scpWrap encrypted:", bytesToHex5(encryptedData));
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
    const PADDING_CHAR = 128;
    if (this.scpVersion === 3) {
      const encryptedData = data.slice(0, -SCP_MAC_LENGTH);
      const receivedMac = data.slice(-SCP_MAC_LENGTH);
      const macData = aesCbcEncryptNoPadding(this.scpMacKey, this.scpMacIv, encryptedData);
      this.scpMacIv = macData.slice(-16);
      const expectedMac = this.scpMacIv.slice(-SCP_MAC_LENGTH);
      if (!arraysEqual(expectedMac, receivedMac)) {
        throw new Error("Invalid SCP MAC");
      }
      const decryptedData = await aesDecryptCBC(this.scpEncKey, this.scpEncIv, encryptedData);
      this.scpEncIv = encryptedData.slice(-16);
      let L3 = decryptedData.length - 1;
      while (decryptedData[L3] !== PADDING_CHAR) {
        L3--;
        if (L3 === -1) {
          throw new Error("Invalid SCP ENC padding");
        }
      }
      return decryptedData.slice(0, L3);
    } else {
      const decryptedData = await aesDecryptCBC(this.key, this.iv, data);
      let L3 = decryptedData.length - 1;
      while (decryptedData[L3] !== PADDING_CHAR) {
        L3--;
        if (L3 === -1) {
          throw new Error("Invalid SCP ENC padding");
        }
      }
      this.iv = data.slice(-16);
      return decryptedData.slice(0, L3);
    }
  }
  /**
   * Select memory segment
   * @param {number} baseAddress 
   */
  async selectSegment(baseAddress) {
    const data = new Uint8Array(5);
    data[0] = 5;
    data[1] = baseAddress >> 24 & 255;
    data[2] = baseAddress >> 16 & 255;
    data[3] = baseAddress >> 8 & 255;
    data[4] = baseAddress & 255;
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Load a chunk of segment data
   * @param {number} offset 
   * @param {Uint8Array} chunk 
   */
  async loadSegmentChunk(offset, chunk) {
    const data = new Uint8Array(3 + chunk.length);
    data[0] = 6;
    data[1] = offset >> 8 & 255;
    data[2] = offset & 255;
    data.set(chunk, 3);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Flush current segment
   */
  async flushSegment() {
    await this.exchange(this.cla, 0, 0, 0, new Uint8Array([7]));
  }
  /**
   * Verify CRC of segment
   * @param {number} offsetSegment 
   * @param {number} lengthSegment 
   * @param {number} crcExpected 
   */
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
  /**
   * Validate target ID
   * @param {number} targetId 
   */
  async validateTargetId(targetId) {
    const data = new Uint8Array(4);
    data[0] = targetId >> 24 & 255;
    data[1] = targetId >> 16 & 255;
    data[2] = targetId >> 8 & 255;
    data[3] = targetId & 255;
    await this.exchange(this.cla, 4, 0, 0, data);
  }
  /**
   * Boot the application
   * @param {number} bootAddr 
   * @param {Uint8Array|null} signature 
   */
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
  /**
   * Commit the application (TLV mode)
   * @param {Uint8Array|null} signature 
   */
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
  /**
   * Create app with install parameters (legacy mode)
   */
  async createAppNoInstallParams(appFlags, appLength, appName, icon = null, path = null, iconOffset = null, iconSize = null, appVersion = null) {
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
  /**
   * Create app with TLV install parameters
   */
  async createApp(codeLength, apiLevel = 0, dataLength = 0, installParamsLength = 0, flags = 0, bootOffset = 1) {
    console.log("createApp params:", { codeLength, apiLevel, dataLength, installParamsLength, flags, bootOffset });
    let params;
    if (apiLevel !== -1) {
      params = new Uint8Array(21);
      params[0] = apiLevel;
      params[1] = codeLength >> 24 & 255;
      params[2] = codeLength >> 16 & 255;
      params[3] = codeLength >> 8 & 255;
      params[4] = codeLength & 255;
      params[5] = dataLength >> 24 & 255;
      params[6] = dataLength >> 16 & 255;
      params[7] = dataLength >> 8 & 255;
      params[8] = dataLength & 255;
      params[9] = installParamsLength >> 24 & 255;
      params[10] = installParamsLength >> 16 & 255;
      params[11] = installParamsLength >> 8 & 255;
      params[12] = installParamsLength & 255;
      params[13] = flags >> 24 & 255;
      params[14] = flags >> 16 & 255;
      params[15] = flags >> 8 & 255;
      params[16] = flags & 255;
      params[17] = bootOffset >> 24 & 255;
      params[18] = bootOffset >> 16 & 255;
      params[19] = bootOffset >> 8 & 255;
      params[20] = bootOffset & 255;
    } else {
      params = new Uint8Array(20);
      let offset = 0;
      params[offset++] = codeLength >> 24 & 255;
      params[offset++] = codeLength >> 16 & 255;
      params[offset++] = codeLength >> 8 & 255;
      params[offset++] = codeLength & 255;
      params[offset++] = dataLength >> 24 & 255;
      params[offset++] = dataLength >> 16 & 255;
      params[offset++] = dataLength >> 8 & 255;
      params[offset++] = dataLength & 255;
      params[offset++] = installParamsLength >> 24 & 255;
      params[offset++] = installParamsLength >> 16 & 255;
      params[offset++] = installParamsLength >> 8 & 255;
      params[offset++] = installParamsLength & 255;
      params[offset++] = flags >> 24 & 255;
      params[offset++] = flags >> 16 & 255;
      params[offset++] = flags >> 8 & 255;
      params[offset++] = flags & 255;
      params[offset++] = bootOffset >> 24 & 255;
      params[offset++] = bootOffset >> 16 & 255;
      params[offset++] = bootOffset >> 8 & 255;
      params[offset++] = bootOffset & 255;
    }
    this.createappParams = params;
    const data = new Uint8Array(1 + params.length);
    data[0] = 11;
    data.set(params, 1);
    console.log("createApp data:", bytesToHex5(data));
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Delete an app by name
   * @param {Uint8Array} appName 
   */
  async deleteApp(appName) {
    const data = new Uint8Array(2 + appName.length);
    data[0] = 12;
    data[1] = appName.length;
    data.set(appName, 2);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Delete an app by hash
   * @param {Uint8Array} appFullHash - 32 bytes
   */
  async deleteAppByHash(appFullHash) {
    if (appFullHash.length !== 32) {
      throw new Error("Invalid hash format, sha256 expected");
    }
    const data = new Uint8Array(33);
    data[0] = 21;
    data.set(appFullHash, 1);
    await this.exchange(this.cla, 0, 0, 0, data);
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
    const hashData = [];
    if (targetId !== null && (targetId & 15) > 3) {
      const tv = targetVersion || "";
      const targetData = new Uint8Array(4 + tv.length);
      targetData[0] = targetId >> 24 & 255;
      targetData[1] = targetId >> 16 & 255;
      targetData[2] = targetId >> 8 & 255;
      targetData[3] = targetId & 255;
      if (tv.length > 0) {
        const encoder = new TextEncoder();
        targetData.set(encoder.encode(tv), 4);
      }
      hashData.push(targetData);
    }
    if (this.createappParams) {
      hashData.push(this.createappParams);
    }
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
      if (data.length > 65536) {
        throw new Error("Invalid data size for loader");
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
          if (chunkLen % 16 !== 0) {
            chunkLen -= chunkLen % 16;
          }
        } else {
          chunkLen = length;
        }
        if (this.cleardataBlockLen && chunkLen % this.cleardataBlockLen) {
          if (chunkLen < this.cleardataBlockLen) {
            throw new Error("Cannot transport data that is not block-aligned");
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
    const totalLen = hashData.reduce((sum, arr) => sum + arr.length, 0);
    const combined = new Uint8Array(totalLen);
    let pos = 0;
    for (const arr of hashData) {
      combined.set(arr, pos);
      pos += arr.length;
    }
    return bytesToHex5(sha2562(combined));
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
    await this.exchange(this.cla, 0, 0, 0, new Uint8Array([19]));
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
    data[offset++] = 18;
    data[offset++] = nameBytes.length;
    data.set(nameBytes, offset);
    offset += nameBytes.length;
    data[offset++] = publicKey.length;
    data.set(publicKey, offset);
    await this.exchange(this.cla, 0, 0, 0, data);
  }
  /**
   * Run an app by name
   * @param {Uint8Array} name 
   */
  async runApp(name) {
    await this.exchange(this.cla, 216, 0, 0, name);
  }
  /**
   * Get device version
   * @returns {Promise<object>}
   */
  async getVersion() {
    const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([16]));
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
      const p1 = restart ? 0 : 1;
      restart = false;
      const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([14]));
      if (response.length === 0) {
        break;
      }
      offset = 0;
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
  /**
   * Get memory info
   * @returns {Promise<object>}
   */
  async getMemInfo() {
    const response = await this.exchange(this.cla, 0, 0, 0, new Uint8Array([17]));
    let offset = 0;
    return {
      systemSize: response[offset] << 24 | response[offset + 1] << 16 | response[offset + 2] << 8 | response[offset + 3],
      applicationsSize: response[offset + 4] << 24 | response[offset + 5] << 16 | response[offset + 6] << 8 | response[offset + 7],
      freeSize: response[offset + 8] << 24 | response[offset + 9] << 16 | response[offset + 10] << 8 | response[offset + 11],
      usedAppSlots: response[offset + 12] << 24 | response[offset + 13] << 16 | response[offset + 14] << 8 | response[offset + 15],
      totalAppSlots: response[offset + 16] << 24 | response[offset + 17] << 16 | response[offset + 18] << 8 | response[offset + 19]
    };
  }
};
async function aesEncryptCBC(key, iv, data) {
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
  return new Uint8Array(encrypted);
}
var AES_SBOX = new Uint8Array([
  99,
  124,
  119,
  123,
  242,
  107,
  111,
  197,
  48,
  1,
  103,
  43,
  254,
  215,
  171,
  118,
  202,
  130,
  201,
  125,
  250,
  89,
  71,
  240,
  173,
  212,
  162,
  175,
  156,
  164,
  114,
  192,
  183,
  253,
  147,
  38,
  54,
  63,
  247,
  204,
  52,
  165,
  229,
  241,
  113,
  216,
  49,
  21,
  4,
  199,
  35,
  195,
  24,
  150,
  5,
  154,
  7,
  18,
  128,
  226,
  235,
  39,
  178,
  117,
  9,
  131,
  44,
  26,
  27,
  110,
  90,
  160,
  82,
  59,
  214,
  179,
  41,
  227,
  47,
  132,
  83,
  209,
  0,
  237,
  32,
  252,
  177,
  91,
  106,
  203,
  190,
  57,
  74,
  76,
  88,
  207,
  208,
  239,
  170,
  251,
  67,
  77,
  51,
  133,
  69,
  249,
  2,
  127,
  80,
  60,
  159,
  168,
  81,
  163,
  64,
  143,
  146,
  157,
  56,
  245,
  188,
  182,
  218,
  33,
  16,
  255,
  243,
  210,
  205,
  12,
  19,
  236,
  95,
  151,
  68,
  23,
  196,
  167,
  126,
  61,
  100,
  93,
  25,
  115,
  96,
  129,
  79,
  220,
  34,
  42,
  144,
  136,
  70,
  238,
  184,
  20,
  222,
  94,
  11,
  219,
  224,
  50,
  58,
  10,
  73,
  6,
  36,
  92,
  194,
  211,
  172,
  98,
  145,
  149,
  228,
  121,
  231,
  200,
  55,
  109,
  141,
  213,
  78,
  169,
  108,
  86,
  244,
  234,
  101,
  122,
  174,
  8,
  186,
  120,
  37,
  46,
  28,
  166,
  180,
  198,
  232,
  221,
  116,
  31,
  75,
  189,
  139,
  138,
  112,
  62,
  181,
  102,
  72,
  3,
  246,
  14,
  97,
  53,
  87,
  185,
  134,
  193,
  29,
  158,
  225,
  248,
  152,
  17,
  105,
  217,
  142,
  148,
  155,
  30,
  135,
  233,
  206,
  85,
  40,
  223,
  140,
  161,
  137,
  13,
  191,
  230,
  66,
  104,
  65,
  153,
  45,
  15,
  176,
  84,
  187,
  22
]);
var AES_RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54]);
function aesKeyExpansion(key) {
  const Nk = key.length / 4;
  const Nr = Nk + 6;
  const Nb = 4;
  const W2 = new Uint8Array(4 * Nb * (Nr + 1));
  for (let i = 0; i < key.length; i++) {
    W2[i] = key[i];
  }
  for (let i = Nk; i < Nb * (Nr + 1); i++) {
    let temp = W2.slice((i - 1) * 4, i * 4);
    if (i % Nk === 0) {
      const t = temp[0];
      temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[i / Nk - 1];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[t];
    } else if (Nk > 6 && i % Nk === 4) {
      temp[0] = AES_SBOX[temp[0]];
      temp[1] = AES_SBOX[temp[1]];
      temp[2] = AES_SBOX[temp[2]];
      temp[3] = AES_SBOX[temp[3]];
    }
    for (let j = 0; j < 4; j++) {
      W2[i * 4 + j] = W2[(i - Nk) * 4 + j] ^ temp[j];
    }
  }
  return { W: W2, Nr };
}
function aesGfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hiBit = a & 128;
    a = a << 1 & 255;
    if (hiBit) a ^= 27;
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
  const { W: W2, Nr } = aesKeyExpansion(key);
  const state = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    state[i] = block[i];
  }
  for (let i = 0; i < 16; i++) {
    state[i] ^= W2[i];
  }
  for (let round = 1; round <= Nr; round++) {
    for (let i = 0; i < 16; i++) {
      state[i] = AES_SBOX[state[i]];
    }
    let t = state[1];
    state[1] = state[5];
    state[5] = state[9];
    state[9] = state[13];
    state[13] = t;
    t = state[2];
    state[2] = state[10];
    state[10] = t;
    t = state[6];
    state[6] = state[14];
    state[14] = t;
    t = state[3];
    state[3] = state[15];
    state[15] = state[11];
    state[11] = state[7];
    state[7] = t;
    if (round < Nr) {
      for (let col = 0; col < 4; col++) {
        const c = state.slice(col * 4, col * 4 + 4);
        aesMixColumn(c);
        state.set(c, col * 4);
      }
    }
    const roundKey = W2.slice(round * 16, round * 16 + 16);
    for (let i = 0; i < 16; i++) {
      state[i] ^= roundKey[i];
    }
  }
  return state;
}
function aesCbcEncryptNoPadding(key, iv, data) {
  if (data.length % 16 !== 0) {
    throw new Error("Data length must be multiple of 16 for CBC without padding");
  }
  const result = new Uint8Array(data.length);
  let prevBlock = iv;
  for (let i = 0; i < data.length; i += 16) {
    const block = new Uint8Array(16);
    for (let j = 0; j < 16; j++) {
      block[j] = data[i + j] ^ prevBlock[j];
    }
    const encryptedBlock = aesEncryptBlock(key, block);
    result.set(encryptedBlock, i);
    prevBlock = encryptedBlock;
  }
  return result;
}
async function aesDecryptCBC(key, iv, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );
  const paddedData = new Uint8Array(data.length + 16);
  paddedData.set(data);
  for (let i = data.length; i < paddedData.length; i++) {
    paddedData[i] = 16;
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      paddedData
    );
    return new Uint8Array(decrypted);
  } catch (e) {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      data
    );
    return new Uint8Array(decrypted);
  }
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
    rootPrivateKey = new Uint8Array(32);
    rootPrivateKey[31] = 1;
    if (debug) {
      console.log(`Using default root private key = 1 (custom CA compatible)`);
    }
  } else {
    rootPrivateKey = typeof rootPrivateKeyOption === "string" ? hexToBytes3(rootPrivateKeyOption) : rootPrivateKeyOption;
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
    iconData = hexToBytes3(iconData);
  }
  let sig = signature;
  if (sig !== null && typeof sig === "string") {
    sig = hexToBytes3(sig);
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
    const bootOffset = bootAddr - printer.minAddr() | 1;
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
    const masterPrivate = new PrivateKey(hexToBytes3(signPrivateKey));
    const sigObj = masterPrivate.ecdsaSign(hexToBytes3(hash), true);
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
    rootKey = new Uint8Array(32);
    rootKey[31] = 1;
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes3(rootPrivateKey) : rootPrivateKey;
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
    rootKey = new Uint8Array(32);
    rootKey[31] = 1;
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes3(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.listApp();
}
async function getMemInfo(dongle, targetId, rootPrivateKey = null) {
  let rootKey;
  if (rootPrivateKey === null) {
    rootKey = new Uint8Array(32);
    rootKey[31] = 1;
  } else {
    rootKey = typeof rootPrivateKey === "string" ? hexToBytes3(rootPrivateKey) : rootPrivateKey;
  }
  const secret = await getDeployedSecretV2(dongle, rootKey, targetId);
  const loader = new HexLoader(dongle, 224, true, secret);
  return await loader.getMemInfo();
}
export {
  BOLOS_TAG_APPNAME,
  BOLOS_TAG_APPVERSION,
  BOLOS_TAG_DATASIZE,
  BOLOS_TAG_DEPENDENCY,
  BOLOS_TAG_DERIVEPATH,
  BOLOS_TAG_ICON,
  CURVES,
  CommException,
  HexLoader,
  IntelHexArea,
  IntelHexParser,
  IntelHexPrinter,
  PrivateKey,
  PublicKey,
  TARGET_IDS,
  TransportMock,
  TransportWebHID,
  bytesToHex,
  combinePackets,
  deleteApp,
  encodelv,
  encodetlv,
  getDeployedSecretV1,
  getDeployedSecretV2,
  getDongle,
  getMemInfo,
  getPossibleErrorCause,
  hexToBytes,
  listApps,
  loadApp,
  parseBip32Path,
  parseSlip21Path,
  splitIntoPackets,
  unwrapResponseAPDU,
  wrapCommandAPDU
};
/*! Bundled license information:

@noble/secp256k1/index.js:
  (*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
