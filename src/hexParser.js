/**
 * Intel HEX File Parser
 * Port of ledgerblue/hexParser.py
 */

/**
 * Represents a memory area from the HEX file
 */
export class IntelHexArea {
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
}

/**
 * Insert area into sorted list by start address
 * @param {IntelHexArea[]} areas 
 * @param {IntelHexArea} area 
 * @returns {IntelHexArea[]}
 */
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

/**
 * Parse Intel HEX format files
 */
export class IntelHexParser {
    constructor(hexContent) {
        this.bootAddr = 0;
        this.areas = [];
        
        // Accept either string content or array of lines
        const lines = typeof hexContent === 'string' 
            ? hexContent.split(/\r?\n/) 
            : hexContent;
        
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
            
            if (line[0] !== ':') {
                throw new Error(`Invalid data at line ${lineNumber}`);
            }

            const data = hexToBytes(line.slice(1));
            const count = data[0];
            const address = (data[1] << 8) + data[2];
            const recordType = data[3];

            // Data record
            if (recordType === 0x00) {
                if (startZone === null) {
                    throw new Error(`Data record but no zone defined at line ${lineNumber}`);
                }
                if (startFirst === null) {
                    startFirst = address;
                    current = startFirst;
                }
                if (address !== current) {
                    this._addArea(new IntelHexArea(
                        startZone * 0x10000 + startFirst,
                        new Uint8Array(zoneData)
                    ));
                    zoneData = [];
                    startFirst = address;
                    current = address;
                }
                // Append data bytes
                for (let i = 0; i < count; i++) {
                    zoneData.push(data[4 + i]);
                }
                current += count;
            }

            // End of file record
            if (recordType === 0x01) {
                if (zoneData.length !== 0) {
                    this._addArea(new IntelHexArea(
                        startZone * 0x10000 + startFirst,
                        new Uint8Array(zoneData)
                    ));
                    zoneData = [];
                    startZone = null;
                    startFirst = null;
                    current = null;
                }
            }

            // Extended segment address (unsupported)
            if (recordType === 0x02) {
                throw new Error("Unsupported record 02");
            }

            // Start segment address (unsupported)
            if (recordType === 0x03) {
                throw new Error("Unsupported record 03");
            }

            // Extended linear address
            if (recordType === 0x04) {
                if (zoneData.length !== 0) {
                    this._addArea(new IntelHexArea(
                        startZone * 0x10000 + startFirst,
                        new Uint8Array(zoneData)
                    ));
                    zoneData = [];
                    startFirst = null;
                    current = null;
                }
                startZone = (data[4] << 8) + data[5];
            }

            // Start linear address (boot address)
            if (recordType === 0x05) {
                // Use multiplication instead of shifts to avoid signed 32-bit conversion
                this.bootAddr = 
                    (data[4] & 0xff) * 0x1000000 +
                    (data[5] & 0xff) * 0x10000 +
                    (data[6] & 0xff) * 0x100 +
                    (data[7] & 0xff);
            }
        }

        // Add last zone if any remaining data
        if (zoneData.length !== 0) {
            this._addArea(new IntelHexArea(
                startZone * 0x10000 + startFirst,
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
        let addr = 0xffffffff;
        for (const area of this.areas) {
            if (area.start < addr) {
                addr = area.start;
            }
        }
        return addr;
    }
}

/**
 * Intel HEX Printer - builds and outputs HEX format
 */
export class IntelHexPrinter {
    constructor(parser = null, eol = '\r\n') {
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
        let addr = 0xffffffff;
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
        return ((-cks) & 0xff);
    }

    _emitBinary(bin) {
        const cks = this._checksum(bin);
        const hexStr = bytesToHex(bin).toUpperCase();
        const cksStr = cks.toString(16).padStart(2, '0').toUpperCase();
        return `:${hexStr}${cksStr}${this.eol}`;
    }

    /**
     * Generate HEX file content as string
     * @param {number} blockSize 
     * @returns {string}
     */
    generate(blockSize = 32) {
        let output = '';

        for (const area of this.areas) {
            let off = 0;
            let oldoff = area.start + 0x10000; // Force emission of selection record at start

            while (off < area.data.length) {
                // Emit offset selection record (extended linear address)
                if ((off & 0xffff0000) !== (oldoff & 0xffff0000)) {
                    const addrHigh = (area.start >> 16) & 0xffff;
                    const record = new Uint8Array([
                        0x02, 0x00, 0x00, 0x04,
                        (addrHigh >> 8) & 0xff,
                        addrHigh & 0xff
                    ]);
                    output += this._emitBinary(record);
                }

                // Calculate chunk size
                const remaining = area.data.length - off;
                const chunkSize = Math.min(remaining, blockSize);
                const addr = (off + (area.start & 0xffff)) & 0xffff;

                // Build data record
                const record = new Uint8Array(4 + chunkSize);
                record[0] = chunkSize;
                record[1] = (addr >> 8) & 0xff;
                record[2] = addr & 0xff;
                record[3] = 0x00; // Data record type
                record.set(area.data.slice(off, off + chunkSize), 4);

                output += this._emitBinary(record);

                oldoff = off;
                off += blockSize;
            }
        }

        // Emit start linear address record
        const bootAddrBytes = new Uint8Array([
            0x04, 0x00, 0x00, 0x05,
            (this.bootAddr >> 24) & 0xff,
            (this.bootAddr >> 16) & 0xff,
            (this.bootAddr >> 8) & 0xff,
            this.bootAddr & 0xff
        ]);
        output += this._emitBinary(bootAddrBytes);

        // Emit end of file record
        output += `:00000001FF${this.eol}`;

        return output;
    }
}

// Utility functions
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export { hexToBytes, bytesToHex };
export default IntelHexParser;
