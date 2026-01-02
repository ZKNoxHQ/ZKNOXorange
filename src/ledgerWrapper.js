/**
 * Ledger HID APDU Framing
 * Port of ledgerblue/ledgerWrapper.py
 * 
 * Handles chunking of APDUs into 64-byte HID reports and reassembly of responses
 */

import { CommException } from './commException.js';

/**
 * Wrap a command APDU into HID packets
 * @param {number} channel - Channel ID (typically 0x0101)
 * @param {Uint8Array} command - The APDU command to wrap
 * @param {number} packetSize - Size of each HID packet (typically 64)
 * @param {boolean} ble - Whether this is for BLE (no channel header)
 * @returns {Uint8Array} - Wrapped packets ready for HID transmission
 */
export function wrapCommandAPDU(channel, command, packetSize, ble = false) {
    if (packetSize < 3) {
        throw new CommException(
            "Can't handle Ledger framing with less than 3 bytes for the report"
        );
    }

    let sequenceIdx = 0;
    let offset = 0;
    const extraHeaderSize = ble ? 0 : 2;
    
    // Build result as array of bytes, then convert to Uint8Array
    let result = [];

    // First packet header
    if (!ble) {
        // Channel ID (big endian)
        result.push((channel >> 8) & 0xff);
        result.push(channel & 0xff);
    }
    
    // Tag (0x05) + sequence (2 bytes) + command length (2 bytes)
    result.push(0x05);
    result.push((sequenceIdx >> 8) & 0xff);
    result.push(sequenceIdx & 0xff);
    result.push((command.length >> 8) & 0xff);
    result.push(command.length & 0xff);
    
    sequenceIdx++;

    // Calculate block size for first packet
    let blockSize = Math.min(
        command.length,
        packetSize - 5 - extraHeaderSize
    );

    // Add first chunk of command
    for (let i = 0; i < blockSize; i++) {
        result.push(command[offset + i]);
    }
    offset += blockSize;

    // Subsequent packets
    while (offset < command.length) {
        if (!ble) {
            result.push((channel >> 8) & 0xff);
            result.push(channel & 0xff);
        }
        
        result.push(0x05);
        result.push((sequenceIdx >> 8) & 0xff);
        result.push(sequenceIdx & 0xff);
        
        sequenceIdx++;

        // Calculate block size for this packet
        blockSize = Math.min(
            command.length - offset,
            packetSize - 3 - extraHeaderSize
        );

        for (let i = 0; i < blockSize; i++) {
            result.push(command[offset + i]);
        }
        offset += blockSize;
    }

    // Pad to packet size boundary (for USB HID)
    if (!ble) {
        while ((result.length % packetSize) !== 0) {
            result.push(0x00);
        }
    }

    return new Uint8Array(result);
}

/**
 * Unwrap response APDU from HID packets
 * @param {number} channel - Channel ID (typically 0x0101)
 * @param {Uint8Array} data - Raw HID data received
 * @param {number} packetSize - Size of each HID packet (typically 64)
 * @param {boolean} ble - Whether this is for BLE (no channel header)
 * @returns {Uint8Array|null} - Unwrapped response or null if incomplete
 */
export function unwrapResponseAPDU(channel, data, packetSize, ble = false) {
    let sequenceIdx = 0;
    let offset = 0;
    const extraHeaderSize = ble ? 0 : 2;

    // Check minimum size for first packet
    if (!data || data.length < 5 + extraHeaderSize + 5) {
        return null;
    }

    // Verify channel (if not BLE)
    if (!ble) {
        const receivedChannel = (data[offset] << 8) | data[offset + 1];
        if (receivedChannel !== channel) {
            throw new CommException("Invalid channel");
        }
        offset += 2;
    }

    // Verify tag
    if (data[offset] !== 0x05) {
        throw new CommException("Invalid tag");
    }
    offset++;

    // Verify sequence
    const receivedSeq = (data[offset] << 8) | data[offset + 1];
    if (receivedSeq !== sequenceIdx) {
        throw new CommException("Invalid sequence");
    }
    offset += 2;

    // Get response length
    const responseLength = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // Check if we have enough data
    if (data.length < 5 + extraHeaderSize + responseLength) {
        return null;
    }

    // Calculate first block size
    let blockSize = Math.min(
        responseLength,
        packetSize - 5 - extraHeaderSize
    );

    // Build result
    let result = [];
    for (let i = 0; i < blockSize; i++) {
        result.push(data[offset + i]);
    }
    offset += blockSize;

    // Read subsequent packets
    while (result.length < responseLength) {
        sequenceIdx++;

        if (offset >= data.length) {
            return null;
        }

        // Verify channel (if not BLE)
        if (!ble) {
            const receivedChannel = (data[offset] << 8) | data[offset + 1];
            if (receivedChannel !== channel) {
                throw new CommException("Invalid channel");
            }
            offset += 2;
        }

        // Verify tag
        if (data[offset] !== 0x05) {
            throw new CommException("Invalid tag");
        }
        offset++;

        // Verify sequence
        const receivedSeq = (data[offset] << 8) | data[offset + 1];
        if (receivedSeq !== sequenceIdx) {
            throw new CommException("Invalid sequence");
        }
        offset += 2;

        // Calculate block size
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

/**
 * Split wrapped data into individual HID reports
 * @param {Uint8Array} wrapped - Wrapped data from wrapCommandAPDU
 * @param {number} packetSize - Size of each HID packet
 * @returns {Uint8Array[]} - Array of individual packets
 */
export function splitIntoPackets(wrapped, packetSize = 64) {
    const packets = [];
    for (let i = 0; i < wrapped.length; i += packetSize) {
        packets.push(wrapped.slice(i, i + packetSize));
    }
    return packets;
}

/**
 * Combine multiple HID reports into single buffer for unwrapping
 * @param {Uint8Array[]} packets - Array of HID packets
 * @returns {Uint8Array} - Combined buffer
 */
export function combinePackets(packets) {
    const totalLength = packets.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const packet of packets) {
        result.set(packet, offset);
        offset += packet.length;
    }
    return result;
}

export default { wrapCommandAPDU, unwrapResponseAPDU, splitIntoPackets, combinePackets };
