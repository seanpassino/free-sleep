// LowDB, stores room-temperature compensation settings in /persistent/free-sleep-data/lowdb/comfortDB.json
// Edit the file directly; it is re-read before every scheduled adjustment.
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import config from '../config.js';

export type SurfaceProbe = 'cen' | 'avg' | 'max' | 'min' | 'body';

export type Comfort = {
  ambientCompensation: {
    enabled: boolean;
    // Bedroom temperature the schedules were tuned in (summer overnight average)
    baseRoomF: number;
    // °F of bed warming per °F the room is below baseRoomF
    gain: number;
    maxOffsetF: number;
    // Steps this warm are the wake-up spike: applied as scheduled, and re-checks stop until the next night
    wakeStepMinF: number;
  };
  // Bed control (8sleep/bedControl.ts): when enabled, the temperature shown and set everywhere is the
  // bed surface temperature, held at its setpoint by adjusting the water. false = water temperatures,
  // as before.
  surfaceControl: {
    enabled: boolean;
    // Surface probe that is "the bed temperature": 'cen' (center/torso zone), 'avg'/'max'/'min', or 'body'
    // (the probes where capacitance finds the sleeper, center when the side is empty; bedControl.ts)
    probe: SurfaceProbe;
    // Room compensation of bed setpoints (scheduled steps, power-on and 15-min re-checks): the same bed
    // temperature feels colder in a colder room (chosen setpoints 2026-10-29 to 11-15: ~75 at a 71-72°F
    // room, 82-84 at 64-66°F). Offset = gain x (baseRoomF - room), rounded, within [minOffsetF, maxOffsetF].
    roomCompensation: {
      enabled: boolean;
      baseRoomF: number;
      gain: number;
      minOffsetF: number;
      maxOffsetF: number;
    };
    // Getting into a pre-warmed bed: time constant (min) over which the water eases from the empty-bed
    // target to the occupied-bed one, and cooling by the loop fades in. 0 = switch at once.
    entryHandoffMinutes: number;
    // Empty bed: the water may run at most this far above the setpoint while warming it (default 8)
    emptyMaxAboveSetpointF?: number;
  };
};

const defaultData: Comfort = {
  ambientCompensation: {
    enabled: true,
    baseRoomF: 76,
    gain: 1,
    maxOffsetF: 10,
    wakeStepMinF: 85,
  },
  surfaceControl: {
    enabled: false,
    probe: 'cen',
    roomCompensation: {
      enabled: false,
      baseRoomF: 72,
      gain: 0.6,
      minOffsetF: -3,
      maxOffsetF: 6,
    },
    entryHandoffMinutes: 20,
  },
};

const file = new JSONFile<Comfort>(`${config.lowDbFolder}comfortDB.json`);
const comfortDB = new Low<Comfort>(file, defaultData);
await comfortDB.read();
comfortDB.data = _.merge({}, defaultData, comfortDB.data);
await comfortDB.write();

export default comfortDB;
