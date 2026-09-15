/**
 * Web Bluetooth transport — README §5.7.
 *
 * By the time this file is swapped in (build order step 5) only the transport
 * is new: the control loop, the protocol and the UI are already proven against
 * the fake turret.
 */

import {
  CONFIG_UUID,
  CONTROL_UUID,
  EVENT_UUID,
  SERVICE_UUID,
  STATE_UUID,
  decodeConfig,
  decodeEvent,
  decodeState,
  encodeConfig,
} from '../shared/protocol.js';
import { backoffMs } from '../shared/adaptive.js';

const KNOWN_DEVICE_KEY = 'turretId';

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export class BleTransport extends EventTarget {
  constructor({ storage = globalThis.localStorage, autoReconnect = true } = {}) {
    super();
    this.storage = storage;
    this.autoReconnect = autoReconnect;
    this.device = null;
    this.server = null;
    this.controlChar = null;
    this.stateChar = null;
    this.eventChar = null;
    this.configChar = null;
    this.connected = false;
    this.attempt = 0;
    this.intentionalDisconnect = false;
    this._writeWithoutResponse = true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * requestDevice needs a secure context AND a user gesture — call this from
   * the setup wizard's "Connect turret" button, never on page load (§5.7).
   */
  async connect() {
    if (!bluetoothAvailable()) {
      throw new Error('Web Bluetooth is unavailable. Use Chrome on Android over HTTPS.');
    }
    this.intentionalDisconnect = false;

    const device = (await this.findKnownDevice()) ?? (await this.pickDevice());
    this.device = device;
    try {
      this.storage?.setItem(KNOWN_DEVICE_KEY, device.id);
    } catch {
      /* private mode — reconnect will just show the picker again */
    }

    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    await this.openGatt();
  }

  async pickDevice() {
    try {
      return await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
    } catch (err) {
      throw new Error(explainBluetoothError(err));
    }
  }

  /**
   * Reconnect without the picker — the rider sets up alone, in boots.
   * getDevices()/watchAdvertisements() availability varies by Chrome version,
   * so feature-detect and fall back to requestDevice.
   */
  async findKnownDevice({ timeoutMs = 6000 } = {}) {
    const wantedId = this.storage?.getItem(KNOWN_DEVICE_KEY);
    if (!wantedId || typeof navigator.bluetooth.getDevices !== 'function') return null;

    const known = await navigator.bluetooth.getDevices().catch(() => []);
    const dev = known.find((d) => d.id === wantedId);
    if (!dev) return null;
    if (dev.gatt?.connected) return dev;
    if (typeof dev.watchAdvertisements !== 'function') return dev;

    // Wait for it to advertise, but never hang the wizard on a turret that is
    // switched off — fall through to the picker instead.
    const seen = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      dev.addEventListener(
        'advertisementreceived',
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
      dev.watchAdvertisements().catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    return seen ? dev : null;
  }

  async openGatt() {
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);

    this.controlChar = await service.getCharacteristic(CONTROL_UUID);
    this.stateChar = await service.getCharacteristic(STATE_UUID);
    this.eventChar = await service.getCharacteristic(EVENT_UUID);
    this.configChar = await service.getCharacteristic(CONFIG_UUID).catch(() => null);

    // writeValueWithoutResponse may be absent on older implementations;
    // 10 Hz survives either way.
    this._writeWithoutResponse = typeof this.controlChar.writeValueWithoutResponse === 'function';

    this.stateChar.addEventListener('characteristicvaluechanged', (e) => {
      try {
        this.emit('state', decodeState(e.target.value));
      } catch (err) {
        this.emit('error', { message: `bad State packet: ${err.message}` });
      }
    });
    await this.stateChar.startNotifications();

    this.eventChar.addEventListener('characteristicvaluechanged', (e) => {
      try {
        this.emit('event', decodeEvent(e.target.value));
      } catch (err) {
        this.emit('error', { message: `bad Event packet: ${err.message}` });
      }
    });
    await this.eventChar.startNotifications();

    this.connected = true;
    this.attempt = 0;
    this.emit('connected', { name: this.device.name ?? 'turret' });
  }

  async write(buffer) {
    if (!this.connected || !this.controlChar) throw new Error('turret not connected');
    if (this._writeWithoutResponse) await this.controlChar.writeValueWithoutResponse(buffer);
    else await this.controlChar.writeValue(buffer);
  }

  // ------------------------------------------------------------ Config (§5.5)

  async readConfig() {
    if (!this.configChar) return null;
    return decodeConfig(await this.configChar.readValue());
  }

  async writeConfig(config) {
    if (!this.configChar) throw new Error('turret has no Config characteristic');
    await this.configChar.writeValue(encodeConfig(config));
  }

  // ------------------------------------------------------------- disconnects

  /**
   * gattserverdisconnected fires on range loss and on the ESP32 rebooting.
   * Reconnect with backoff; KEEP STREAMING THROUGHOUT — this handler must
   * never touch the RTCPeerConnection (§6).
   */
  onDisconnected() {
    this.connected = false;
    this.emit('disconnected', { reason: 'gattserverdisconnected', willRetry: !this.intentionalDisconnect });
    if (this.intentionalDisconnect || !this.autoReconnect) return;

    const delay = backoffMs(this.attempt);
    this.attempt++;
    setTimeout(() => {
      if (this.intentionalDisconnect) return;
      this.openGatt().catch((err) => {
        this.emit('error', { message: explainBluetoothError(err) });
        this.onDisconnected();
      });
    }, delay);
  }

  async disconnect() {
    this.intentionalDisconnect = true;
    this.connected = false;
    try {
      await this.stateChar?.stopNotifications();
      await this.eventChar?.stopNotifications();
    } catch {
      /* the link may already be gone */
    }
    this.device?.gatt?.disconnect();
  }
}

/**
 * Detect the failure and explain it in plain language, don't fail silently
 * (§5.7). Android 12+ needs BLUETOOTH_CONNECT/BLUETOOTH_SCAN; older Android
 * needs Location enabled for BLE scanning.
 */
export function explainBluetoothError(err) {
  const name = err?.name ?? '';
  const message = String(err?.message ?? err);

  if (name === 'NotFoundError' && /user cancel/i.test(message)) {
    return 'No turret chosen. Tap "Connect turret" and pick PaddockPal-XXXX from the list.';
  }
  if (name === 'NotFoundError') {
    return 'No turret found. Check it is powered on and within a few metres, and that Location is switched on — Android needs Location enabled to scan for Bluetooth devices.';
  }
  if (name === 'SecurityError') {
    return 'Bluetooth was blocked. The page must be served over HTTPS and "Connect turret" must be tapped by hand.';
  }
  if (name === 'NotAllowedError') {
    return 'Bluetooth permission was refused. On Android 12 and later, allow "Nearby devices" for Chrome in system settings.';
  }
  if (name === 'NetworkError') {
    return 'Lost the link to the turret. Reconnecting — the stream keeps running.';
  }
  if (name === 'InvalidStateError') {
    return 'A Bluetooth write was already in flight. The newest command was kept and the stale one dropped.';
  }
  return message;
}
