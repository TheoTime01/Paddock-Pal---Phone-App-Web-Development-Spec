#!/usr/bin/env node
/**
 * Generate the ESP32 header from shared/protocol.js — README §1:
 * "Generate the ESP32 header from it or keep them in lockstep by hand, but do
 * not let two hand-written copies drift."
 *
 *   npm run protocol:header -- ../firmware/include/paddock_protocol.h
 *
 * Firmware is out of scope for this repo, so this writes to stdout by default.
 */

import { writeFileSync } from 'node:fs';
import {
  ANGLE_MAX_CDEG,
  ANGLE_MIN_CDEG,
  AccelProfile,
  COMMAND_TIMEOUT_MS,
  CONFIG_BYTES,
  CONFIG_UUID,
  CONN_INTERVAL_MS,
  CONTROL_BYTES,
  CONTROL_UUID,
  ControlFlags,
  DisplayState,
  EVENT_BYTES,
  EVENT_UUID,
  EventId,
  Mode,
  SERVICE_UUID,
  STATE_BYTES,
  STATE_UUID,
  StatusBits,
  TEMP_OFFSET_C,
} from '../src/shared/protocol.js';

const defines = (name, obj) =>
  Object.entries(obj)
    .map(([k, v]) => `#define PP_${name}_${k} ${v}`)
    .join('\n');

const header = `/* GENERATED FILE — do not edit.
 * Source of truth: src/shared/protocol.js (README §5).
 * Regenerate with: npm run protocol:header
 *
 * All multi-byte fields are little-endian; all angles are centidegrees.
 */
#ifndef PADDOCK_PROTOCOL_H
#define PADDOCK_PROTOCOL_H

#include <stdint.h>

#define PP_SERVICE_UUID "${SERVICE_UUID}"
#define PP_CONTROL_UUID "${CONTROL_UUID}"
#define PP_STATE_UUID   "${STATE_UUID}"
#define PP_EVENT_UUID   "${EVENT_UUID}"
#define PP_CONFIG_UUID  "${CONFIG_UUID}"

#define PP_CONN_INTERVAL_MIN_MS ${CONN_INTERVAL_MS.min}
#define PP_CONN_INTERVAL_MAX_MS ${CONN_INTERVAL_MS.max}

/* No Control write for this long -> hold position, show LOST. Never home. */
#define PP_COMMAND_TIMEOUT_MS ${COMMAND_TIMEOUT_MS}

#define PP_ANGLE_MIN_CDEG (${ANGLE_MIN_CDEG})
#define PP_ANGLE_MAX_CDEG (${ANGLE_MAX_CDEG})
#define PP_TEMP_OFFSET_C ${TEMP_OFFSET_C}

${defines('MODE', Mode)}

${defines('DISPLAY', DisplayState)}

${defines('FLAG', ControlFlags)}

${defines('STATUS', StatusBits)}

${defines('EVENT', EventId)}

${defines('ACCEL', AccelProfile)}

#pragma pack(push, 1)

/* ${CONTROL_BYTES} bytes, phone -> ESP32, <= 20 Hz (nominal 10 Hz) */
struct pp_control {
  uint8_t  seq;            /* wraps at 255; echoed in state for latency */
  uint8_t  mode;           /* PP_MODE_* */
  int16_t  target_cdeg;    /* +/-18000 */
  uint16_t max_rate_cds;   /* 0 = use config default; firmware clamps */
  uint8_t  flags;          /* PP_FLAG_* */
  uint8_t  display_state;  /* PP_DISPLAY_* — drives the GC9A01 face */
};

/* ${STATE_BYTES} bytes, ESP32 -> phone, notify @ 10 Hz */
struct pp_state {
  uint8_t  seq_echo;
  uint8_t  status;         /* PP_STATUS_* */
  int16_t  angle_cdeg;     /* actual encoder angle — the phone depends on it */
  int16_t  rate_cds;
  uint16_t vbat_mv;
  uint8_t  batt_pct;
  uint8_t  temp_c;         /* offset +40: value 40 == 0 C */
  uint8_t  fault_code;
  uint8_t  reserved;
};

/* ${EVENT_BYTES} bytes, ESP32 -> phone, notify on change */
struct pp_event {
  uint8_t event_id;        /* PP_EVENT_* */
  uint8_t arg;
};

/* ${CONFIG_BYTES} bytes, read/write, set once during setup */
struct pp_config {
  int16_t  limit_cw_cdeg;
  int16_t  limit_ccw_cdeg;
  uint16_t default_rate_cds;
  uint8_t  accel_profile;  /* PP_ACCEL_* */
  uint8_t  reserved;
};

#pragma pack(pop)

/* If any of these fail, the two sides have drifted — regenerate, don't patch. */
_Static_assert(sizeof(struct pp_control) == ${CONTROL_BYTES}, "control must be ${CONTROL_BYTES} bytes");
_Static_assert(sizeof(struct pp_state) == ${STATE_BYTES}, "state must be ${STATE_BYTES} bytes");
_Static_assert(sizeof(struct pp_event) == ${EVENT_BYTES}, "event must be ${EVENT_BYTES} bytes");
_Static_assert(sizeof(struct pp_config) == ${CONFIG_BYTES}, "config must be ${CONFIG_BYTES} bytes");

#endif /* PADDOCK_PROTOCOL_H */
`;

const out = process.argv[2];
if (out) {
  writeFileSync(out, header);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(header);
}
