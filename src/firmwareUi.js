/**
 * Firmware UI glue for the pages that embed ZKNOX Orange (sideloader.html on zknox.com).
 *
 * The page keeps the HTML and the few things that are page-specific (log,
 * progress bar, device-info panel, the connect flow). Everything about the
 * firmware buttons lives here so both pages stay identical in behaviour.
 *
 * Usage:
 *   const fw = new FirmwareUi({
 *     getTransport: () => transport,
 *     setTransport: (t) => { transport = t; },
 *     log, progress: updateProgress, showProgress,
 *     onDeviceInfo: (info) => { ...refresh the device panel / app list... },
 *     onFirmwareStatus: ({ state, info, ctx }) => { ...show "up to date" / "x.y.z available" in the device panel... },
 *     buttons: { firmware: 'firmwareBtn', recovery: 'recoveryBtn', lockWhileUpdating: ['connectBtn', 'refreshBtn', 'genuineBtn'] },
 *     config: { liveCommonVersion, provider, apiBase, socketBase },   // optional
 *   });
 *   fw.mount();   // wires the buttons
 */

import { FirmwareUpdater } from './firmwareUpdater.js';
import { TransportWebHID } from './transport.js';
import { TransportWebBLE } from './transportBle.js';
import { bytesToHex } from './ecWrapper.js';

const GET_VERSION = new Uint8Array([0xe0, 0x01, 0x00, 0x00, 0x00]);

export class FirmwareUi {
    constructor(opts) {
        this.getTransport = opts.getTransport;
        this.setTransport = opts.setTransport;
        this.log = opts.log || (() => {});
        this.progress = opts.progress || (() => {});
        this.showProgress = opts.showProgress || (() => {});
        this.onDeviceInfo = opts.onDeviceInfo || (() => {});
        // ({ state: 'checking' | 'up-to-date' | 'update-available' | 'bootloader' | 'unknown', info, ctx, error })
        this.onFirmwareStatus = opts.onFirmwareStatus || (() => {});
        this.config = opts.config || {};
        this.buttons = {
            firmware: 'firmwareBtn',
            recovery: 'recoveryBtn',
            lockWhileUpdating: ['connectBtn', 'refreshBtn', 'genuineBtn'],
            ...(opts.buttons || {}),
        };
        this.labels = {
            check: '📦 Check Firmware',
            update: '⬆️ Update Firmware',
            recovery: '🛠️ Bootloader Recovery',
            ...(opts.labels || {}),
        };
        this.updateContext = null;
    }

    el(id) { return document.getElementById(id); }

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
        this.setFirmwareButton('check', false);
    }

    setFirmwareButton(mode, disabled = false) {
        const btn = this.el(this.buttons.firmware);
        if (!btn) return;
        btn.disabled = disabled;
        btn.classList.toggle('warning', mode === 'update');
        btn.classList.toggle('secondary', mode !== 'update');
        btn.textContent = mode === 'update' ? this.labels.update : this.labels.check;
        btn.onclick = mode === 'update' ? () => this.update() : () => this.check();
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
                if (name === 'allowSecureChannelRequested') this.log('Allow the secure channel on your device', 'warning');
                if (name === 'devicePermissionRequested') this.log('Confirm the firmware update on your device', 'warning');
            },
            config: this.config,
        });
    }

    async refreshDeviceInfo(updater) {
        this.setTransport(updater.transport);
        const info = await updater.getDeviceInfo();
        this.onDeviceInfo(info);
        return info;
    }

    // ---- actions ----

    /**
     * Silent check, meant to run right after a connect: no progress bar, one log line
     * only when an update exists. Sets the firmware button mode and reports through
     * onFirmwareStatus. Returns the update context or null.
     */
    async probe() {
        this.onFirmwareStatus({ state: 'checking', info: null, ctx: null });
        try {
            const updater = this.makeUpdater();
            const info = await updater.getDeviceInfo();
            if (info.isBootloader) {
                this.updateContext = null;
                this.setFirmwareButton('check');
                this.onFirmwareStatus({ state: 'bootloader', info, ctx: null });
                return null;
            }
            const ctx = await updater.getLatestFirmware(info);
            this.updateContext = ctx;
            this.setFirmwareButton(ctx ? 'update' : 'check');
            this.onFirmwareStatus({ state: ctx ? 'update-available' : 'up-to-date', info, ctx });
            if (ctx) {
                this.log(`⚠️ Firmware update available: ${ctx.currentVersion} → ${ctx.targetVersion}` +
                    (ctx.shouldFlashMCU ? ' (MCU update included)' : ''), 'warning');
            }
            return ctx;
        } catch (error) {
            console.error('Firmware probe error:', error);
            this.onFirmwareStatus({ state: 'unknown', info: null, ctx: null, error });
            this.log(`Firmware check failed: ${error.message}`, 'warning');
            return null;
        }
    }

    async check() {
        this.setBusy(this.buttons.firmware, 'Checking...');
        this.showProgress(true);
        this.progress(20, 'Querying Ledger servers...');
        try {
            const updater = this.makeUpdater();
            const info = await updater.getDeviceInfo();
            if (info.isBootloader) {
                this.log('Device is in bootloader mode: use Bootloader Recovery', 'warning');
                return;
            }
            const ctx = await updater.getLatestFirmware(info);
            this.progress(100, ctx ? 'Update available!' : 'Firmware is up to date!');
            this.onFirmwareStatus({ state: ctx ? 'update-available' : 'up-to-date', info, ctx });
            if (!ctx) {
                this.updateContext = null;
                this.log(`✓ Firmware ${info.version} is up to date`, 'success');
                return;
            }
            this.updateContext = ctx;
            this.log(`⚠️ FIRMWARE UPDATE AVAILABLE: ${ctx.currentVersion} → ${ctx.targetVersion}`, 'warning');
            this.log(ctx.shouldFlashMCU
                ? `MCU ${info.mcuVersion} must also be flashed (device will pass through bootloader mode)`
                : `Secure Element only (MCU ${info.mcuVersion} is compatible)`, 'info');
            this.log('Click "Update Firmware" to start. Keep the device plugged in for the whole process.', 'info');
        } catch (error) {
            console.error('Firmware check error:', error);
            this.log(`Firmware check failed: ${error.message}`, 'error');
            this.progress(0, 'Check failed');
        } finally {
            this.setFirmwareButton(this.updateContext ? 'update' : 'check');
            setTimeout(() => this.showProgress(false), 2000);
        }
    }

    async update() {
        if (!this.updateContext) {
            this.log('No firmware update available. Check first.', 'error');
            return;
        }
        const ctx = this.updateContext;
        this.setBusy(this.buttons.firmware, 'Updating...');
        this.lock(true);
        this.showProgress(true);
        try {
            this.log('⚠️ DO NOT unplug your device during the update, even when the screen goes blank.', 'warning');
            const updater = this.makeUpdater();
            await updater.update(ctx);
            const info = await this.refreshDeviceInfo(updater);
            this.updateContext = null;
            this.onFirmwareStatus({ state: 'up-to-date', info, ctx: null });
            this.log(`✓ Device now on firmware ${info.version}`, 'success');
        } catch (error) {
            console.error('Firmware update error:', error);
            this.log(`Firmware update failed: ${error.message}`, 'error');
            this.log('If the device shows "Bootloader", unplug it, plug it back holding the left button and use Bootloader Recovery.', 'warning');
            this.progress(0, 'Update failed');
        } finally {
            this.lock(false);
            this.setFirmwareButton(this.updateContext ? 'update' : 'check');
            setTimeout(() => this.showProgress(false), 3000);
        }
    }

    async recover() {
        this.setBusy(this.buttons.recovery, 'Recovering...');
        this.showProgress(true);
        this.progress(5, 'Connecting to device in bootloader mode...');
        try {
            this.log('🛠️ Bootloader recovery: flashing bootloader/MCU matching the firmware on the Secure Element', 'warning');
            // A transport opened on the dashboard is stale once the device is replugged in
            // bootloader mode (other product id): probe it, re-pair on any failure.
            let transport = this.getTransport();
            let probeOk = false;
            if (transport && transport.opened) {
                try { await transport.exchange(GET_VERSION); probeOk = true; } catch (e) { probeOk = false; }
            }
            if (!probeOk) {
                if (transport) { try { await transport.close(); } catch (e) { /* ignore */ } }
                transport = await TransportWebHID.request(true);
                this.setTransport(transport);
            }
            this.log(`GET_VERSION: ${bytesToHex(await transport.exchange(GET_VERSION))}`, 'info');
            const updater = this.makeUpdater();
            await updater.repair();
            const info = await this.refreshDeviceInfo(updater);
            this.log(`✓ Device recovered: ${info.version}`, 'success');
        } catch (error) {
            console.error('Recovery error:', error);
            this.log(`Recovery failed: ${error.message}`, 'error');
            this.progress(0, 'Recovery failed');
        } finally {
            const btn = this.el(this.buttons.recovery);
            if (btn) { btn.disabled = false; btn.textContent = this.labels.recovery; }
            setTimeout(() => this.showProgress(false), 5000);
        }
    }

    // ---- reconnect modal: WebHID needs a user gesture to pair the re-enumerated device ----

    showReconnectModal(message, kind = 'usb') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'zknox-reconnect-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999;';
            const modal = document.createElement('div');
            modal.style.cssText = 'background:#0a0a0f;border:1px solid rgba(167,139,250,0.3);border-radius:16px;padding:30px;text-align:center;max-width:420px;';
            const title = document.createElement('h3');
            title.style.cssText = 'color:#fff;margin:0 0 15px 0;';
            title.textContent = '🔌 Reconnect Device';
            const text = document.createElement('p');
            text.style.cssText = 'color:#a78bfa;margin:0 0 20px 0;';
            text.textContent = message;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';
            const mkBtn = (label, request) => {
                const btn = document.createElement('button');
                btn.style.cssText = 'background:#238636;color:#fff;border:none;padding:12px 24px;border-radius:6px;font-size:16px;cursor:pointer;';
                btn.textContent = label;
                btn.onclick = async () => {
                    for (const b of row.children) b.disabled = true;
                    btn.textContent = 'Connecting...';
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
            const usb = mkBtn('🔌 Reconnect USB', () => TransportWebHID.request(true));
            row.appendChild(usb);
            if (TransportWebBLE.isSupported()) {
                const ble = mkBtn('📶 Reconnect Bluetooth', () => TransportWebBLE.request(true));
                if (kind === 'ble') { row.insertBefore(ble, usb); } else { row.appendChild(ble); }
            }
            modal.append(title, text, row);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
        });
    }
}
