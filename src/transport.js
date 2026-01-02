/**
 * Ledger Transport Layer (WebHID)
 * Port of ledgerblue/comm.py
 * 
 * Provides communication with Ledger devices via WebHID API
 */

import { CommException, getPossibleErrorCause } from './commException.js';
import { wrapCommandAPDU, unwrapResponseAPDU } from './ledgerWrapper.js';

// Constants
const LEDGER_VENDOR_ID = 0x2c97;
const HID_PACKET_SIZE = 64;
const CHANNEL_ID = 0x0101;
const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * WebHID Transport for Ledger devices
 */
export class TransportWebHID {
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

        // Set up input report handler
        this.device.addEventListener('inputreport', (event) => {
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
                reject(new CommException('Timeout waiting for device response'));
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
            throw new CommException('Device not opened');
        }

        if (this.debug) {
            console.log('HID => ' + bytesToHex(apdu));
        }

        // Wrap APDU for HID transport
        const wrapped = wrapCommandAPDU(CHANNEL_ID, apdu, HID_PACKET_SIZE);

        // Send all packets
        for (let offset = 0; offset < wrapped.length; offset += HID_PACKET_SIZE) {
            const packet = wrapped.slice(offset, offset + HID_PACKET_SIZE);
            // WebHID sendReport requires report ID as first parameter
            await this.device.sendReport(0x00, packet);
        }

        // Receive response packets
        let responseBuffer = new Uint8Array(0);
        let response = null;

        while (response === null) {
            const packet = await this._waitForInputReport(timeout);
            
            // Accumulate packets
            const newBuffer = new Uint8Array(responseBuffer.length + packet.length);
            newBuffer.set(responseBuffer);
            newBuffer.set(packet, responseBuffer.length);
            responseBuffer = newBuffer;

            // Try to unwrap
            response = unwrapResponseAPDU(CHANNEL_ID, responseBuffer, HID_PACKET_SIZE);
        }

        // Check status word (last 2 bytes)
        if (response.length < 2) {
            throw new CommException('Response too short');
        }

        const swOffset = response.length - 2;
        const sw = (response[swOffset] << 8) | response[swOffset + 1];
        const data = response.slice(0, swOffset);

        if (this.debug) {
            console.log('HID <= ' + bytesToHex(data) + ' SW=' + sw.toString(16).padStart(4, '0'));
        }

        // Check for errors
        if (sw !== 0x9000 && (sw & 0xff00) !== 0x6100 && (sw & 0xff00) !== 0x6c00) {
            const cause = getPossibleErrorCause(sw);
            throw new CommException(
                `Invalid status ${sw.toString(16).padStart(4, '0')} (${cause})`,
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
            throw new CommException('WebHID not supported in this browser');
        }

        const devices = await navigator.hid.requestDevice({
            filters: [{ vendorId: LEDGER_VENDOR_ID }]
        });

        if (devices.length === 0) {
            throw new CommException('No Ledger device selected');
        }

        // Find the correct interface (interface 0 or usage page 0xFFA0)
        let selectedDevice = devices[0];
        for (const device of devices) {
            if (device.collections) {
                for (const collection of device.collections) {
                    if (collection.usagePage === 0xffa0) {
                        selectedDevice = device;
                        break;
                    }
                }
            }
        }

        const transport = new TransportWebHID(selectedDevice, debug);
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
            throw new CommException('WebHID not supported in this browser');
        }

        const devices = await navigator.hid.getDevices();
        const ledgerDevices = devices.filter(d => d.vendorId === LEDGER_VENDOR_ID);

        return ledgerDevices.map(device => new TransportWebHID(device, debug));
    }

    /**
     * Open first available device
     * @param {boolean} debug - Enable debug logging
     * @returns {Promise<TransportWebHID>}
     */
    static async openFirst(debug = false) {
        const transports = await TransportWebHID.getDevices(debug);
        
        if (transports.length === 0) {
            // No paired devices, request one
            return TransportWebHID.request(debug);
        }

        const transport = transports[0];
        await transport.open();
        return transport;
    }
}

/**
 * Mock transport for testing without hardware
 */
export class TransportMock {
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
            console.log('MOCK => ' + bytesToHex(apdu));
        }

        this.exchanges.push(new Uint8Array(apdu));

        let response;
        if (this.responseHandler) {
            response = await this.responseHandler(apdu);
        } else {
            // Default: return success with no data
            response = new Uint8Array([0x90, 0x00]);
        }

        if (this.debug) {
            console.log('MOCK <= ' + bytesToHex(response));
        }

        // Check status word
        if (response.length < 2) {
            throw new CommException('Response too short');
        }

        const swOffset = response.length - 2;
        const sw = (response[swOffset] << 8) | response[swOffset + 1];
        const data = response.slice(0, swOffset);

        if (sw !== 0x9000 && (sw & 0xff00) !== 0x6100 && (sw & 0xff00) !== 0x6c00) {
            const cause = getPossibleErrorCause(sw);
            throw new CommException(
                `Invalid status ${sw.toString(16).padStart(4, '0')} (${cause})`,
                sw,
                data
            );
        }

        return data;
    }

    apduMaxDataSize() {
        return 255;
    }
}

/**
 * Get a dongle transport (either WebHID or mock)
 * @param {boolean} debug - Enable debug logging
 * @param {object} mock - Optional mock transport
 * @returns {Promise<TransportWebHID|TransportMock>}
 */
export async function getDongle(debug = false, mock = null) {
    if (mock) {
        return mock;
    }
    return TransportWebHID.openFirst(debug);
}

// Utility functions
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export default TransportWebHID;
