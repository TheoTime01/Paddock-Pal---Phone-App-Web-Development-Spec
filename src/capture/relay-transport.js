/**
 * Relay transport — stub. iOS has no Web Bluetooth, so an iPhone turret phone
 * would reach the ESP32 over a WSS relay instead (an ESP32 that joins the same
 * network and bridges the same §5 packets).
 *
 * The point of the stub is that the interface is fixed now: identical events,
 * identical ArrayBuffers, identical §5 semantics. Nothing above control.js
 * changes when this is filled in.
 */

import { decodeEvent, decodeState } from '../shared/protocol.js';

export class RelayTransport extends EventTarget {
  constructor({ url } = {}) {
    super();
    this.url = url;
    this.connected = false;
    this.ws = null;
  }

  async connect() {
    throw new Error('Relay transport is not implemented yet — use BLE on Android.');
  }

  async disconnect() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  async write() {
    throw new Error('Relay transport is not implemented yet.');
  }

  /**
   * Wire format once implemented: a 1-byte channel tag followed by the §5
   * payload, so the relay stays dumb and shared/protocol.js stays the only
   * place byte layouts appear.
   */
  onMessage(data) {
    const view = new DataView(data);
    const channel = view.getUint8(0);
    const body = new DataView(data, 1);
    if (channel === 0x02) this.dispatchEvent(new CustomEvent('state', { detail: decodeState(body) }));
    else if (channel === 0x03) this.dispatchEvent(new CustomEvent('event', { detail: decodeEvent(body) }));
  }
}
