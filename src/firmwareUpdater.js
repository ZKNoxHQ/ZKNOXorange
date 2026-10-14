/**
 * Firmware update through Ledger's HSM scriptrunner.
 *
 * Port of @ledgerhq/live-common 34.51:
 *   - socket/index.js                      (scriptrunner protocol)
 *   - deviceSDK/tasks/updateFirmware.js    (OSU -> bootloader/MCU loop)
 *   - hw/firmwareUpdate-main.js            (final firmware step, old devices)
 *   - hw/firmwareUpdate-repair.js          (bootloader recovery)
 *   - @ledgerhq/device-core parseGetVersionResponse / getLatestFirmwareForDevice
 *
 * The host is only an APDU proxy: every byte flashed on the device is produced
 * and authenticated by Ledger's HSM. Nothing here bypasses it.
 *
 * Sequence (same as Ledger Live):
 *   1. GET get_device_version / get_firmware_version / get_latest_firmware /
 *      firmware_final_versions/<id> / mcu_versions
 *      -> { osu, final, shouldFlashMCU }
 *   2. wss .../update/install?targetId&livecommonversion&perso&firmware&firmwareKey  (OSU triple)
 *      The device asks for confirmation on the LAST bulk APDU, then reboots.
 *   3. Reconnect. If shouldFlashMCU the device is now in bootloader mode:
 *      wss .../update/mcu?targetId=<bootloader targetId>&livecommonversion&version=<v>
 *      where v = mcu.name if the bootloader already is mcu.from_bootloader_version,
 *      else v = that bootloader version (flash the bootloader first). Loop until the
 *      device leaves bootloader mode (at most MAX_FLASH_REPETITIONS).
 *      NEVER send /update/mcu with the bootloader's own version string: that is what
 *      kills devices.
 *   4. If final.firmware is non-empty (old Nano S firmwares), the device must be in
 *      OSU mode: wss .../update/install with the FINAL triple. Modern firmwares ship
 *      an empty final.firmware: the OSU applies the SE update by itself.
 */

import { CommException } from './commException.js';
import { bytesToHex, hexToBytes } from './ecWrapper.js';
import { TransportWebHID } from './transport.js';
import { TransportWebBLE } from './transportBle.js';

export const FIRMWARE_DEFAULTS = Object.freeze({
    liveCommonVersion: '34.51.0',
    provider: 1,
    apiBase: 'https://manager.api.live.ledger.com/api',
    socketBase: 'wss://scriptrunner.api.live.ledger.com/update',
    apduTimeoutMs: 60000,            // ordinary APDU (socket exchange / bulk)
    userConfirmTimeoutMs: 900000,    // APDU blocked on an on-device confirmation
    maxFlashRepetitions: 5,
    reconnectPollMs: 1000,
    reconnectAutoMs: 25000,          // silent getDevices() polling before asking the user
});

const SW_OK = 0x9000;
const SW_LOCKED = 0x5515;
const SW_USER_REFUSED = 0x5501;
const SW_CONDITIONS_NOT_SATISFIED = 0x6985;

export class FirmwareError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'FirmwareError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// GET_VERSION parsing (device-core parseGetVersionResponse)
// ---------------------------------------------------------------------------

export function getDeviceModelName(targetId) {
    switch (targetId & 0xffff0000) {
        case 0x31100000: return 'Nano S';
        case 0x33000000: return 'Nano X';
        case 0x33100000: return 'Nano S Plus';
        case 0x33200000: return 'Stax';
        case 0x33300000: return 'Flex';
        default: return 'Unknown';
    }
}

function u32be(data, i) {
    return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
}

function cstr(bytes) {
    if (bytes.length && bytes[bytes.length - 1] === 0) bytes = bytes.slice(0, -1);
    return new TextDecoder().decode(bytes);
}

/**
 * @param {Uint8Array} data - GET_VERSION response data, status word already stripped
 */
export function parseGetVersion(data) {
    let i = 0;
    const targetId = u32be(data, i); i += 4;
    const rawVersionLength = data[i++];
    let rawVersion = new TextDecoder().decode(data.slice(i, i + rawVersionLength));
    i += rawVersionLength;
    const flagsLength = data[i++];
    let flags = Array.from(data.slice(i, i + flagsLength));
    i += flagsLength;
    if (!rawVersionLength) { rawVersion = '0.0.0'; flags = []; }

    const isBootloader = (targetId & 0xf0000000) !== 0x30000000;
    let mcuVersion = '', mcuBlVersion = null, seVersion = null, seTargetId = null, mcuTargetId = null;

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

    const isOSU = rawVersion.includes('-osu');
    const version = rawVersion.replace('-osu', '');
    const m = rawVersion.match(/([0-9]+.[0-9]+(.[0-9]+){0,1})?(-(.*))?/);
    const majMin = (m && m[1]) || '';

    return {
        targetId, rawVersion, version, majMin, flags,
        isBootloader, isOSU,
        seVersion, seTargetId, mcuVersion, mcuBlVersion, mcuTargetId,
        model: getDeviceModelName(isBootloader && seTargetId ? seTargetId : targetId),
        managerAllowed: !!(flags[0] & 0x08),
        pinValidated: !!(flags[0] & 0x80),
    };
}

// ---------------------------------------------------------------------------
// semver helpers (replaces `semver` for MCU selection)
// ---------------------------------------------------------------------------

function coerce(v) {
    const m = String(v || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
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

export function findBestMCU(mcus) {
    if (!mcus.length) return null;
    let best = mcus[0];
    for (let k = 1; k < mcus.length; k++) {
        if (semverGt(mcus[k].name, best.name)) best = mcus[k];
    }
    return best;
}

/** majMin of the bootloader a given MCU can be flashed from, and whether we are on it. */
export function getFlashMcuOrBootloaderDetails(deviceMajMin, mcuFromBootloaderVersion) {
    const bootloaderVersion = String(mcuFromBootloaderVersion || '').split('.').slice(0, 3).join('.');
    return { bootloaderVersion, isMcuUpdate: deviceMajMin === bootloaderVersion };
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export class FirmwareUpdater {
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
        this.onLog = opts.onLog || (() => {});
        this.onProgress = opts.onProgress || (() => {});
        this.onEvent = opts.onEvent || (() => {});
        this.cfg = { ...FIRMWARE_DEFAULTS, ...(opts.config || {}) };
        this.provider = this.cfg.provider;
    }

    log(message, type = 'info') { this.onLog(message, type); }
    progress(percent, text) { this.onProgress(Math.round(percent), text); }

    // ---- HTTP manager API ----

    async api(path, query = {}) {
        const q = new URLSearchParams({ livecommonversion: this.cfg.liveCommonVersion, ...query });
        const resp = await fetch(`${this.cfg.apiBase}/${path}?${q}`);
        if (!resp.ok) throw new FirmwareError('ManagerApiError', `${path}: HTTP ${resp.status}`);
        return resp.json();
    }

    /** port of device-core getLatestFirmwareForDevice. Returns null when up to date. */
    async getLatestFirmware(deviceInfo) {
        const provider = this.provider;
        const mcusPromise = this.api('mcu_versions');
        const deviceVersion = await this.api('get_device_version', { provider, target_id: deviceInfo.targetId });

        let osu;
        if (deviceInfo.isOSU) {
            osu = await this.api('get_osu_version', {
                device_version: deviceVersion.id, version_name: `${deviceInfo.version}-osu`, provider,
            });
        } else {
            const current = await this.api('get_firmware_version', {
                device_version: deviceVersion.id, version_name: deviceInfo.version, provider,
            });
            const salt = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
            const latest = await this.api('get_latest_firmware', {
                salt, current_se_firmware_final_version: current.id, device_version: deviceVersion.id, provider,
            });
            osu = latest.result === 'null' ? null : latest.se_firmware_osu_version;
        }
        if (!osu) return null;

        const mcus = await mcusPromise;
        const currentMcu = mcus.find(m => m.name === deviceInfo.mcuVersion);
        if (!currentMcu) throw new FirmwareError('UnknownMCU', `Unknown MCU version "${deviceInfo.mcuVersion}"`);

        const final = await this.api(`firmware_final_versions/${osu.next_se_firmware_final_version}`);
        const shouldFlashMCU = !final.mcu_versions.includes(currentMcu.id);

        return {
            osu, final, shouldFlashMCU, mcus,
            currentVersion: deviceInfo.version,
            targetVersion: final.version || final.name,
        };
    }

    /** port of ManagerAPI.retrieveMcuVersion */
    retrieveMcuVersion(final, mcus) {
        const available = mcus.filter(m =>
            m.providers.includes(this.provider) &&
            m.from_bootloader_version !== 'none' &&
            final.mcu_versions.includes(m.id));
        return findBestMCU(available);
    }

    // ---- device ----

    async getDeviceInfo(transport = this.transport) {
        const data = await transport.exchange(new Uint8Array([0xe0, 0x01, 0x00, 0x00, 0x00]), this.cfg.apduTimeoutMs);
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
            try { await previous.close(); } catch (e) { /* already gone */ }
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
                        if (d.vendorId === 0x2c97) candidates.push(new TransportWebHID(d, false));
                    }
                }
            } catch (e) { /* keep polling */ }
            for (const t of candidates) {
                try {
                    await t.open();
                    const info = await this.getDeviceInfo(t);
                    this.transport = t;
                    this.log(`Device back over ${bleDevice ? 'Bluetooth' : 'USB'}: ${info.isBootloader ? 'bootloader ' + info.rawVersion : info.rawVersion}`, 'info');
                    return info;
                } catch (e) {
                    try { await t.close(); } catch (_) { /* ignore */ }
                    if (e && e.sw === SW_LOCKED) this.log('Device is locked, unlock it to continue...', 'warning');
                }
            }
        }
        this.transport = await this.reconnect(message, bleDevice ? 'ble' : 'usb');
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
            const done = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve();
            };

            const ws = new WebSocket(url);
            ws.onopen = () => self.log('Connected to Ledger HSM', 'info');
            ws.onerror = () => {
                if (inBulkMode) return;
                done(new FirmwareError('WebsocketConnectionError', 'HSM websocket error'));
            };
            ws.onclose = () => {
                if (inBulkMode) return;
                if (correctlyFinished) done();
                else done(deviceError || new FirmwareError('WebsocketConnectionError', 'HSM websocket closed'));
            };

            ws.onmessage = async (e) => {
                try {
                    const input = JSON.parse(e.data);
                    switch (input.query) {
                        case 'exchange': {
                            deviceError = null;
                            const apdu = hexToBytes(input.data);
                            const pendingAllowSecureChannel = apdu[0] === 0xe0 && apdu[1] === 0x51;
                            if (pendingAllowSecureChannel) self.onEvent('allowSecureChannelRequested');
                            const timeout = pendingAllowSecureChannel ? cfg.userConfirmTimeoutMs : cfg.apduTimeoutMs;

                            let status, data;
                            try {
                                data = await transport.exchange(apdu, timeout);
                                status = SW_OK;
                            } catch (err) {
                                if (!(err instanceof CommException) || err.data == null) {
                                    throw err;   // transport failure (timeout, disconnect), not a status word
                                }
                                status = err.sw;
                                data = err.data || new Uint8Array(0);
                            }

                            let response;
                            if (status === SW_OK) {
                                response = 'success';
                            } else if (status === SW_LOCKED) {
                                throw new FirmwareError('DeviceLocked', 'Device is locked');
                            } else if ((status === SW_USER_REFUSED || status === SW_CONDITIONS_NOT_SATISFIED) && pendingAllowSecureChannel) {
                                throw new FirmwareError('UserRefusedAllowManager', 'Secure channel refused on device');
                            } else {
                                response = 'error';
                                deviceError = new FirmwareError('TransportStatusError', `Device returned 0x${status.toString(16)}`);
                            }
                            if (pendingAllowSecureChannel) self.onEvent('allowSecureChannelGranted');
                            ws.send(JSON.stringify({ nonce: input.nonce, response, data: bytesToHex(data) }));
                            break;
                        }
                        case 'bulk': {
                            // The HSM is done talking: close the socket and unroll APDUs with the device.
                            inBulkMode = true;
                            ws.close();
                            const apdus = (input.data || []).filter(d => d !== '').map(hexToBytes);
                            const total = apdus.length;
                            if (o.onProgress) o.onProgress(0, total);
                            for (let i = 0; i < total; i++) {
                                const last = i === total - 1;
                                const timeout = o.unresponsiveExpectedDuringBulk ? cfg.userConfirmTimeoutMs : cfg.apduTimeoutMs;
                                if (last && o.unresponsiveExpectedDuringBulk) self.onEvent('devicePermissionRequested');
                                try {
                                    await transport.exchange(apdus[i], timeout);
                                } catch (err) {
                                    if (last && o.rebootExpectedAtEndOfBulk && isDisconnect(err)) {
                                        self.log('Device rebooted before acknowledging the last APDU (expected)', 'info');
                                        break;
                                    }
                                    throw mapFirmwareStatus(err);
                                }
                                if (last && o.unresponsiveExpectedDuringBulk) self.onEvent('devicePermissionGranted');
                                if (o.onProgress) o.onProgress(i + 1, total);
                            }
                            correctlyFinished = true;
                            done();
                            break;
                        }
                        case 'success':
                            if (inBulkMode) break;
                            correctlyFinished = true;
                            done();
                            break;
                        case 'error':
                            if (inBulkMode) break;
                            throw new FirmwareError('DeviceSocketFail', `HSM error: ${input.data}`);
                        case 'warning':
                            if (inBulkMode) break;
                            self.log(`HSM warning: ${input.data}`, 'warning');
                            break;
                        default:
                            break;
                    }
                } catch (err) {
                    deviceError = err;
                    try { ws.close(); } catch (_) { /* ignore */ }
                    done(err);
                }
            };
        });
    }

    socketUrl(path, query) {
        const q = new URLSearchParams({ livecommonversion: this.cfg.liveCommonVersion, ...query });
        return `${this.cfg.socketBase}/${path}?${q}`;
    }

    installOsu(targetId, osu, base, span) {
        this.log(`Installing OSU ${osu.name || ''}...`, 'info');
        return this.runSocket(this.socketUrl('install', {
            targetId, perso: osu.perso, firmware: osu.firmware, firmwareKey: osu.firmware_key,
        }), {
            unresponsiveExpectedDuringBulk: true,
            rebootExpectedAtEndOfBulk: true,
            onProgress: (i, n) => this.progress(base + span * (i / n), i === n - 1
                ? 'Confirm the update on your device...'
                : `Installing OSU ${i}/${n}`),
        });
    }

    flashMcuOrBootloader(targetId, version, label, base, span) {
        this.log(`Flashing ${label} ${version} (bootloader targetId 0x${targetId.toString(16)})...`, 'warning');
        this.log('DO NOT unplug the device.', 'warning');
        return this.runSocket(this.socketUrl('mcu', { targetId, version }), {
            unresponsiveExpectedDuringBulk: true,
            rebootExpectedAtEndOfBulk: true,
            onProgress: (i, n) => this.progress(base + span * (i / n), `Flashing ${label} ${i}/${n}`),
        });
    }

    installFinal(targetId, final, base, span) {
        this.log(`Installing final firmware ${final.name || final.version}...`, 'info');
        return this.runSocket(this.socketUrl('install', {
            targetId, perso: final.perso, firmware: final.firmware, firmwareKey: final.firmware_key,
        }), {
            unresponsiveExpectedDuringBulk: true,
            rebootExpectedAtEndOfBulk: true,
            onProgress: (i, n) => this.progress(base + span * (i / n), `Installing firmware ${i}/${n}`),
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
            throw new FirmwareError('DeviceOnDashboardExpected', 'Device must be on the dashboard (not bootloader / OSU)');
        }
        this.log(`Firmware update ${info.version} -> ${ctx.targetVersion}` +
            (shouldFlashMCU ? ' (MCU update required)' : ' (SE only)'), 'warning');

        // 1. OSU
        this.progress(2, 'Installing OSU...');
        await this.installOsu(info.targetId, osu, 2, 40);
        this.log('OSU installed, device is rebooting...', 'success');
        this.progress(42, 'Device rebooting...');

        // 2. reconnect
        info = await this.waitForDevice('Your Ledger rebooted after the OSU step. Plug it back / unlock it, then reconnect.');

        // 3. bootloader / MCU loop
        if (shouldFlashMCU) {
            if (!info.isBootloader) {
                throw new FirmwareError('DeviceOnBootloaderExpected',
                    `Expected the device in bootloader mode, got ${info.rawVersion}. Unplug it and plug it back holding the left button, then use Bootloader Recovery.`);
            }
            let repetitions = 0;
            while (info.isBootloader) {
                if (repetitions > cfg.maxFlashRepetitions) {
                    throw new FirmwareError('TooManyMcuOrBootloaderFlashes', 'Still in bootloader after too many flashes');
                }
                const mcuVersion = this.retrieveMcuVersion(final, mcus);
                if (!mcuVersion) throw new FirmwareError('McuVersionNotFound', 'No MCU found for this firmware on this provider');
                const { bootloaderVersion, isMcuUpdate } = getFlashMcuOrBootloaderDetails(info.majMin, mcuVersion.from_bootloader_version);
                const version = isMcuUpdate ? mcuVersion.name : bootloaderVersion;
                const base = 45 + repetitions * 10;
                await this.flashMcuOrBootloader(info.targetId, version, isMcuUpdate ? 'MCU' : 'bootloader', base, 10);
                this.log(`${isMcuUpdate ? 'MCU' : 'Bootloader'} ${version} flashed, device rebooting...`, 'success');
                info = await this.waitForDevice('Your Ledger rebooted after the MCU step. Reconnect it.');
                repetitions++;
            }
        }

        // 4. final firmware (only when the API ships one)
        if (final && final.firmware) {
            if (!info.isOSU) {
                throw new FirmwareError('DeviceInOSUExpected', `Expected the device in OSU mode, got ${info.rawVersion}`);
            }
            this.progress(85, 'Installing final firmware...');
            await this.installFinal(info.targetId, final, 85, 12);
            info = await this.waitForDevice('Your Ledger rebooted with the new firmware. Unlock it and reconnect.');
        } else if (info.isOSU) {
            // The OSU applies the SE update by itself on reboot; give it a moment.
            this.log('Device still reports OSU, waiting for it to finish...', 'info');
            info = await this.waitForDevice('Your Ledger is finishing the update. Unlock it and reconnect.');
        }

        this.progress(100, `Firmware ${info.version}`);
        this.log(`Firmware update complete: ${info.version} (MCU ${info.mcuVersion})`, 'success');
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
            this.log(`Device reports ${info.rawVersion} (${info.model}), not the bootloader: nothing to repair. ` +
                'To force bootloader mode, unplug the device and plug it back while holding the left button.', 'warning');
            return info;
        }
        this.log(`Bootloader ${info.mcuBlVersion} (targetId 0x${info.targetId.toString(16)}), ` +
            `SE ${info.seVersion || '?'} (targetId ${info.seTargetId ? '0x' + info.seTargetId.toString(16) : '?'})`, 'info');
        const mcus = await this.api('mcu_versions');
        const available = mcus.filter(m => m.providers.includes(this.provider) && m.from_bootloader_version !== 'none');
        let repetitions = 0;
        while (info.isBootloader) {
            if (repetitions > cfg.maxFlashRepetitions) {
                throw new FirmwareError('TooManyMcuOrBootloaderFlashes', 'Still in bootloader after too many flashes');
            }
            let version;
            if (info.seVersion && info.seTargetId) {
                const finalFirmware = await this.finalFirmwareForSe(info.seTargetId, info.seVersion);
                const mcu = findBestMCU(available.filter(m => finalFirmware.mcu_versions.includes(m.id)));
                if (!mcu) throw new FirmwareError('McuVersionNotFound', `No MCU for SE ${info.seVersion}`);
                const expected = coerce(mcu.from_bootloader_version).join('.');
                const current = coerce(info.mcuBlVersion).join('.');
                // live-common's repair sends from_bootloader_version verbatim ("4.0.5.0"); the
                // regular update flow sends its 3-component form ("4.0.5"). Use the latter: it is
                // the one every Ledger Live update goes through.
                version = expected === current ? mcu.name : expected;
                this.log(`SE ${info.seVersion} wants MCU ${mcu.name} on bootloader ${expected}; current bootloader ${current}: flashing ${version}`, 'info');
            } else {
                // Old bootloaders do not report the SE: pick the best MCU flashable from this bootloader.
                const current = coerce(info.mcuBlVersion).join('.');
                const mcu = findBestMCU(available.filter(m => coerce(m.from_bootloader_version).join('.') === current));
                if (!mcu) throw new FirmwareError('McuVersionNotFound', `No MCU compatible with bootloader ${info.rawVersion}`);
                version = mcu.name;
                this.log(`No SE info from bootloader ${current}: flashing MCU ${version}`, 'info');
            }
            await this.flashMcuOrBootloader(info.targetId, version, 'MCU/bootloader', 10 + repetitions * 20, 20);
            info = await this.waitForDevice('Your Ledger rebooted. Reconnect it (hold the left button while plugging it if it is still in bootloader).');
            repetitions++;
        }

        // Device interrupted between OSU and final firmware (old devices with a final blob)
        if (info.isOSU) {
            this.log(`Secure Element is on OSU ${info.rawVersion}: finishing the update`, 'warning');
            const ctx = await this.getLatestFirmware(info);
            if (ctx && ctx.final && ctx.final.firmware) {
                await this.installFinal(info.targetId, ctx.final, 85, 12);
            }
            info = await this.waitForDevice('Your Ledger is finishing the update. Unlock it and reconnect.');
        }

        this.progress(100, 'Recovered');
        this.log(`Device recovered: firmware ${info.version}, MCU ${info.mcuVersion}`, 'success');
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
        const deviceVersion = await this.api('get_device_version', { provider, target_id: seTargetId });
        const isOSU = seVersion.includes('-osu');
        const version = seVersion.replace('-osu', '');
        if (!isOSU) {
            try {
                return await this.api('get_firmware_version', { device_version: deviceVersion.id, version_name: version, provider });
            } catch (e) {
                this.log(`get_firmware_version(${version}) failed (${e.message}), trying the OSU record`, 'warning');
            }
        }
        const osu = await this.api('get_osu_version', { device_version: deviceVersion.id, version_name: `${version}-osu`, provider });
        return this.api(`firmware_final_versions/${osu.next_se_firmware_final_version}`);
    }
}

// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isDisconnect(err) {
    const m = String(err && err.message || '').toLowerCase();
    return m.includes('disconnect') || m.includes('timeout') || m.includes('not opened') || m.includes('failed to write');
}

function mapFirmwareStatus(err) {
    if (!(err instanceof CommException)) return err;
    switch (err.sw) {
        case 0x6a84: case 0x5103:
            return new FirmwareError('NotEnoughSpace', 'Not enough space on device for the firmware');
        case 0x6a85: case 0x5102: case 0x6985: case 0x5501:
            return new FirmwareError('UserRefusedFirmwareUpdate', 'Update refused on device');
        default:
            return err;
    }
}
