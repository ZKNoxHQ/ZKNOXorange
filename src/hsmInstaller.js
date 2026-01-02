/**
 * HSM Installer for Official Ledger Apps
 * 
 * This module allows installing official Ledger apps by proxying
 * communication between Ledger's HSM (via WebSocket) and the device.
 * 
 * Works on PRODUCTION devices - no custom signing required!
 */

// Ledger API constants
const LIVE_COMMON_VERSION = '34.0.0';
const PROVIDER = 1;
const BASE_API_V1_URL = 'https://manager.api.live.ledger.com/api';
const BASE_API_V2_URL = 'https://manager.api.live.ledger.com/api/v2';
const BASE_SOCKET_URL = 'wss://scriptrunner.api.live.ledger.com/update';

// Device target IDs
const TARGET_IDS = {
    nanos: 0x31100004,
    nanox: 0x33000004,
    nanosp: 0x33100004,
    stax: 0x33200004,
    flex: 0x33300004
};

// Get device model name from target ID
function getDeviceModel(targetId) {
    const masked = targetId & 0xFFFF0000;
    switch (masked) {
        case 0x31100000: return 'Nano S';
        case 0x33000000: return 'Nano X';
        case 0x33100000: return 'Nano S Plus';
        case 0x33200000: return 'Stax';
        case 0x33300000: return 'Flex';
        default: return 'Unknown';
    }
}

/**
 * Parse device version response
 * @param {Uint8Array} data - Response data
 * @returns {Object} Device info
 */
function parseVersionInfo(data) {
    let i = 0;
    
    if (data.length < 5) {
        throw new Error('Not enough data for version info');
    }
    
    const targetId = (data[i] << 24) | (data[i+1] << 16) | (data[i+2] << 8) | data[i+3];
    i += 4;
    
    const versionLen = data[i++];
    if (data.length < i + versionLen + 1) {
        throw new Error('Not enough data for version string');
    }
    
    const version = new TextDecoder().decode(data.slice(i, i + versionLen));
    i += versionLen;
    
    const flagsLen = data[i++];
    const flags = data.slice(i, i + flagsLen);
    i += flagsLen;
    
    let mcuVersion = null;
    if (i < data.length) {
        const mcuLen = data[i++];
        if (i + mcuLen <= data.length) {
            let mcuData = data.slice(i, i + mcuLen);
            // Remove trailing null
            if (mcuData[mcuData.length - 1] === 0) {
                mcuData = mcuData.slice(0, -1);
            }
            mcuVersion = new TextDecoder().decode(mcuData);
        }
    }
    
    return {
        targetId,
        version,
        flags: Array.from(flags),
        mcuVersion,
        model: getDeviceModel(targetId)
    };
}

/**
 * Parse installed apps list response
 * @param {Uint8Array} data - Response data
 * @returns {Array} List of installed apps
 */
function parseInstalledApps(data) {
    const apps = [];
    let i = 0;
    
    if (data.length === 0) return apps;
    
    // First byte should be 0x01
    if (data[i] !== 0x01) return apps;
    i++;
    
    while (i < data.length) {
        if (data.length < i + 1 + 2 + 2 + 32 + 32 + 1) break;
        
        const len = data[i++];
        const blocks = (data[i] << 8) | data[i+1];
        i += 2;
        const flags = (data[i] << 8) | data[i+1];
        i += 2;
        const hashCodeData = data.slice(i, i + 32);
        i += 32;
        const hash = data.slice(i, i + 32);
        i += 32;
        const nameLen = data[i++];
        
        if (data.length < i + nameLen) break;
        
        const name = new TextDecoder().decode(data.slice(i, i + nameLen));
        i += nameLen;
        
        apps.push({
            name,
            hash: Array.from(hash),
            hashCodeData: Array.from(hashCodeData),
            blocks,
            flags
        });
    }
    
    return apps;
}

/**
 * Convert bytes to hex string
 */
function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

/**
 * HSM Installer class
 */
export class HsmInstaller {
    constructor(transport) {
        this.transport = transport;
        this.deviceInfo = null;
        this.onLog = null;
        this.onProgress = null;
    }
    
    log(message, type = 'info') {
        if (this.onLog) {
            this.onLog(message, type);
        }
        console.log(`[HSM ${type}] ${message}`);
    }
    
    progress(percent, message) {
        if (this.onProgress) {
            this.onProgress(percent, message);
        }
    }
    
    /**
     * Send APDU to device
     */
    async exchange(cla, ins, p1, p2, data = new Uint8Array(0)) {
        const apdu = new Uint8Array(5 + data.length);
        apdu[0] = cla;
        apdu[1] = ins;
        apdu[2] = p1;
        apdu[3] = p2;
        apdu[4] = data.length;
        apdu.set(data, 5);
        
        return await this.transport.exchange(apdu);
    }
    
    /**
     * Get device information
     */
    async getDeviceInfo() {
        this.log('Getting device info...');
        
        // GET_VERSION command: E0 01 00 00
        const response = await this.exchange(0xE0, 0x01, 0x00, 0x00);
        
        if (response.length < 2) {
            throw new Error('Invalid response');
        }
        
        const sw = (response[response.length - 2] << 8) | response[response.length - 1];
        if (sw === 0x5515) {
            throw new Error('Device is locked. Please unlock it first.');
        }
        if (sw !== 0x9000) {
            throw new Error(`Device error: 0x${sw.toString(16)}`);
        }
        
        const data = response.slice(0, -2);
        this.deviceInfo = parseVersionInfo(data);
        
        this.log(`Device: ${this.deviceInfo.model}, Firmware: ${this.deviceInfo.version}`, 'success');
        return this.deviceInfo;
    }
    
    /**
     * List installed apps
     */
    async listInstalledApps() {
        this.log('Listing installed apps...');
        
        let allApps = [];
        
        // LIST_APPS command: E0 DE 00 00
        let response = await this.exchange(0xE0, 0xDE, 0x00, 0x00);
        let sw = (response[response.length - 2] << 8) | response[response.length - 1];
        
        if (sw === 0x9000) {
            allApps = allApps.concat(parseInstalledApps(response.slice(0, -2)));
            
            // Continue listing: E0 DF 00 00
            while (true) {
                response = await this.exchange(0xE0, 0xDF, 0x00, 0x00);
                const data = response.slice(0, -2);
                if (data.length === 0) break;
                allApps = allApps.concat(parseInstalledApps(data));
            }
        }
        
        this.log(`Found ${allApps.length} installed app(s)`, 'success');
        return allApps;
    }
    
    /**
     * Get available apps from Ledger catalog
     */
    async getAvailableApps() {
        if (!this.deviceInfo) {
            await this.getDeviceInfo();
        }
        
        this.log('Fetching app catalog from Ledger...');
        
        const url = `${BASE_API_V2_URL}/apps/by-target?` + 
            `livecommonversion=${LIVE_COMMON_VERSION}&` +
            `provider=${PROVIDER}&` +
            `target_id=${this.deviceInfo.targetId}&` +
            `firmware_version_name=${this.deviceInfo.version}`;
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch app catalog: ${response.status}`);
        }
        
        const apps = await response.json();
        this.log(`Found ${apps.length} available app(s)`, 'success');
        return apps;
    }
    
    /**
     * Get app info by name
     */
    async getAppInfo(appName) {
        const apps = await this.getAvailableApps();
        const lowerName = appName.toLowerCase();
        const app = apps.find(a => a.versionName.toLowerCase() === lowerName);
        
        if (!app) {
            throw new Error(`App "${appName}" not found for this device`);
        }
        
        return app;
    }
    
    /**
     * Get firmware perso info (needed for genuine check and install)
     */
    async getFirmwarePerso() {
        if (!this.deviceInfo) {
            await this.getDeviceInfo();
        }
        
        // Get device version ID
        const devVerUrl = `${BASE_API_V1_URL}/get_device_version?` +
            `livecommonversion=${LIVE_COMMON_VERSION}&` +
            `provider=${PROVIDER}&` +
            `target_id=${this.deviceInfo.targetId}`;
        
        const devVerResp = await fetch(devVerUrl);
        if (!devVerResp.ok) {
            throw new Error(`Failed to get device version: ${devVerResp.status}`);
        }
        const deviceVersion = await devVerResp.json();
        
        // Get firmware info
        const firmUrl = `${BASE_API_V1_URL}/get_firmware_version?` +
            `livecommonversion=${LIVE_COMMON_VERSION}&` +
            `device_version=${deviceVersion.id}&` +
            `version_name=${this.deviceInfo.version}&` +
            `provider=${PROVIDER}`;
        
        const firmResp = await fetch(firmUrl);
        if (!firmResp.ok) {
            throw new Error(`Failed to get firmware info: ${firmResp.status}`);
        }
        const firmwareInfo = await firmResp.json();
        
        return firmwareInfo.perso;
    }
    
    /**
     * Run genuine check via HSM
     */
    async genuineCheck() {
        if (!this.deviceInfo) {
            await this.getDeviceInfo();
        }
        
        this.log('Running genuine check...');
        this.progress(10, 'Getting firmware info...');
        
        const perso = await this.getFirmwarePerso();
        
        this.progress(20, 'Connecting to Ledger HSM...');
        
        const wsUrl = `${BASE_SOCKET_URL}/genuine?` +
            `targetId=${this.deviceInfo.targetId}&` +
            `perso=${encodeURIComponent(perso)}`;
        
        await this.queryViaWebSocket(wsUrl);
        
        this.log('Device is genuine!', 'success');
        this.progress(100, 'Genuine check passed');
        return true;
    }
    
    /**
     * Install app via HSM
     */
    async installApp(appName) {
        if (!this.deviceInfo) {
            await this.getDeviceInfo();
        }
        
        this.log(`Installing ${appName}...`);
        this.progress(5, 'Getting app info...');
        
        const appInfo = await this.getAppInfo(appName);
        
        this.log(`Found ${appInfo.versionName} v${appInfo.version}`);
        this.progress(15, 'Connecting to Ledger HSM...');
        
        const wsUrl = `${BASE_SOCKET_URL}/install?` +
            `targetId=${this.deviceInfo.targetId}&` +
            `perso=${encodeURIComponent(appInfo.perso)}&` +
            `deleteKey=${encodeURIComponent(appInfo.deleteKey)}&` +
            `firmware=${encodeURIComponent(appInfo.firmware)}&` +
            `firmwareKey=${encodeURIComponent(appInfo.firmwareKey)}&` +
            `hash=${encodeURIComponent(appInfo.hash)}`;
        
        await this.queryViaWebSocket(wsUrl);
        
        this.log(`${appInfo.versionName} installed successfully!`, 'success');
        this.progress(100, 'Installation complete');
        return appInfo;
    }
    
    /**
     * Delete app via HSM
     */
    async deleteApp(appName) {
        if (!this.deviceInfo) {
            await this.getDeviceInfo();
        }
        
        this.log(`Deleting ${appName}...`);
        this.progress(5, 'Getting app info...');
        
        const appInfo = await this.getAppInfo(appName);
        const perso = await this.getFirmwarePerso();
        
        this.progress(15, 'Connecting to Ledger HSM...');
        
        // For delete, we use the app's deleteKey and perso
        const wsUrl = `${BASE_SOCKET_URL}/install?` +
            `targetId=${this.deviceInfo.targetId}&` +
            `perso=${encodeURIComponent(perso)}&` +
            `deleteKey=${encodeURIComponent(appInfo.deleteKey)}&` +
            `delete=true`;
        
        await this.queryViaWebSocket(wsUrl);
        
        this.log(`${appName} deleted successfully!`, 'success');
        this.progress(100, 'Deletion complete');
        return true;
    }
    
    /**
     * Open app on device
     */
    async openApp(appName) {
        this.log(`Opening ${appName}...`);
        
        const nameBytes = new TextEncoder().encode(appName);
        const response = await this.exchange(0xE0, 0xD8, 0x00, 0x00, nameBytes);
        
        const sw = (response[response.length - 2] << 8) | response[response.length - 1];
        if (sw !== 0x9000) {
            throw new Error(`Failed to open app: 0x${sw.toString(16)}`);
        }
        
        this.log(`${appName} opened`, 'success');
        return true;
    }
    
    /**
     * Close current app (return to dashboard)
     */
    async closeApp() {
        this.log('Closing current app...');
        
        // Close app: B0 A7 00 00
        const response = await this.exchange(0xB0, 0xA7, 0x00, 0x00);
        
        const sw = (response[response.length - 2] << 8) | response[response.length - 1];
        if (sw !== 0x9000 && sw !== 0x6985) {
            throw new Error(`Failed to close app: 0x${sw.toString(16)}`);
        }
        
        this.log('App closed', 'success');
        return true;
    }
    
    /**
     * WebSocket communication with Ledger HSM
     */
    async queryViaWebSocket(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            let bulkCount = 0;
            let bulkTotal = 0;
            
            ws.onopen = () => {
                this.log('Connected to HSM');
            };
            
            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    
                    if (msg.query === 'exchange') {
                        // Single APDU exchange
                        const cmdHex = msg.data;
                        const cmdBytes = hexToBytes(cmdHex);
                        
                        // Parse APDU
                        if (cmdBytes.length < 5) {
                            throw new Error('Invalid APDU command');
                        }
                        
                        const response = await this.transport.exchange(cmdBytes);
                        const sw = (response[response.length - 2] << 8) | response[response.length - 1];
                        const respData = response.slice(0, -2);
                        
                        const wsResp = {
                            nonce: msg.nonce,
                            response: sw === 0x9000 ? 'success' : 'error',
                            data: bytesToHex(respData)
                        };
                        
                        ws.send(JSON.stringify(wsResp));
                        
                    } else if (msg.query === 'bulk') {
                        // Bulk APDU commands
                        const commands = msg.data || [];
                        bulkTotal = commands.length;
                        bulkCount = 0;
                        
                        this.progress(20, `Processing ${bulkTotal} commands...`);
                        
                        for (const cmdHex of commands) {
                            if (!cmdHex) continue;
                            
                            const cmdBytes = hexToBytes(cmdHex);
                            await this.transport.exchange(cmdBytes);
                            
                            bulkCount++;
                            const pct = 20 + Math.floor((bulkCount / bulkTotal) * 70);
                            this.progress(pct, `Processing ${bulkCount}/${bulkTotal}...`);
                        }
                        
                        const wsResp = {
                            nonce: msg.nonce,
                            response: 'success',
                            data: ''
                        };
                        
                        ws.send(JSON.stringify(wsResp));
                        
                    } else if (msg.query === 'success') {
                        this.progress(95, 'Finalizing...');
                        ws.close();
                        resolve();
                        
                    } else if (msg.query === 'error') {
                        ws.close();
                        reject(new Error(`HSM error: ${event.data}`));
                        
                    } else if (msg.query === 'warning') {
                        this.log(`HSM warning: ${event.data}`, 'warning');
                    }
                    
                } catch (error) {
                    ws.close();
                    reject(error);
                }
            };
            
            ws.onerror = (error) => {
                reject(new Error(`WebSocket error: ${error.message || 'Connection failed'}`));
            };
            
            ws.onclose = (event) => {
                if (!event.wasClean && event.code !== 1000) {
                    reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
                }
            };
        });
    }
}

// Export constants for external use
export { TARGET_IDS, getDeviceModel, LIVE_COMMON_VERSION, PROVIDER };
