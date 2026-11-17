// Bed (surface) temperature control. With comfortDB `surfaceControl.enabled`, the temperature the app,
// HA, the side buttons and schedules show and set is the bed surface temperature, not the water's.
// The firmware only takes a water target, so this is a PI loop around it, recalculated every minute:
// water target = feed-forward(setpoint) + offset (the integral term) + proportional term.
// While the side is empty only the first two apply and the offset is left alone; once it has been empty
// a while the water is aimed at the empty bed instead (emptyBedWaterF). Getting into that pre-warmed bed
// eases the water from one to the other instead of jumping (Handoff).
// State: /persistent/free-sleep-data/bed-state.json.
import fs from 'fs';
import comfortDB from '../db/comfort.js';
import logger from '../logger.js';
import config from '../config.js';
import { isPresent } from '../routes/metrics/presence.js';
import { readLatestSensors } from './rawSensors.js';
import { levelToF, MAX_TARGET_F, MIN_TARGET_F } from './temperatureLevels.js';
const BED_STATE = '/persistent/free-sleep-data/bed-state.json';
// Bed temperature = median of the chosen probe over 5 min (sheds the ~0.2°F sample jitter)
const SURFACE_WINDOW_MS = 5 * 60 * 1000;
const SURFACE_STALE_SECONDS = 10 * 60;
// Loop tuning, from the nights of 2026-10-30 to 11-01: the bed follows the water with a gain of about
// 0.7 and a time constant of about 18 min, and the water follows its target in about 5 min.
// Water °F per °F of bed error, applied at once: this is also what speeds up a setpoint change, and it
// fades by itself as the bed arrives
const PROPORTIONAL_GAIN = 1.5;
const MAX_PROPORTIONAL_F = 6;
// Offset change per minute per °F of error (integral time about 21 min)
const INTEGRAL_GAIN_PER_MIN = 0.07;
// Below this the error is sensor jitter (one firmware level is ~0.2-0.3°F)
const INTEGRAL_DEADBAND_F = 0.15;
// A larger error is the bed catching up to a change; integrating it would overshoot
const INTEGRAL_MAX_ERROR_F = 1.5;
// Nor while the bed is already heading to the setpoint this fast (°F per min, 5 min average): the water
// it is climbing on is enough, and more would carry it past (seen on the first live step, 2026-11-01)
const INTEGRAL_APPROACH_RATE = 0.05;
const TREND_SMOOTHING_MINUTES = 5;
const MAX_OFFSET_F = 10;
// The bed moves about 0.72°F per 1°F of water (body heat counts for less as the water warms), so a
// setpoint 1°F warmer needs the water about 1.4°F warmer. With this the offset is the same at every
// setpoint, so a wake-up ramp doesn't carry over into the next night's bedtime.
const FEED_FORWARD_SLOPE = 0.4;
const FEED_FORWARD_REFERENCE_F = 76;
// Empty bed. The offset is mostly body heat (the probe under a sleeper reads 2-4°F above the water), so
// applied to an empty bed it left the bed 4-7°F under the setpoint on cold nights (2026-11-12 to 11-14:
// got into a 70°F bed at setpoint 75, room 65). Settled empty bed, nights 10-29 to 11-15 (586 min, more
// than 45 min after anyone was in it, room 64-72°F): bed = 0.11 + 0.520 x water + 0.515 x room (SD 0.86).
const EMPTY_BED_INTERCEPT_F = 0.11;
const EMPTY_BED_WATER = 0.52;
const EMPTY_BED_ROOM = 0.515;
// Fully holding an empty bed in a cold room takes water far above the setpoint (80 at 66°F: ~88), which
// would be too hot to get into once body heat adds its 2-4°F, so the pre-warm stops here
const EMPTY_MAX_ABOVE_SETPOINT_F = 4;
// Only after the side has been empty this long: presence flickers, and reads empty for a few minutes
// after a restart even with someone in bed
const EMPTY_AFTER_MS = 10 * 60 * 1000;
const ROOM_WINDOW_MS = 30 * 60 * 1000;
// Getting in. The empty-bed water runs well above the occupied-bed water (83 against 76°F at setpoint 79
// in a 66°F room), and for the first 10-15 min body heat lifts the probe 2-4°F whatever the water does
// (fit of 7 entries, 10-30 to 11-15: body heat arrives with a 9 min time constant, the water's effect
// with 16). Switching formulas at once, with the proportional term reading that rise as "too warm",
// dropped the water 83 -> 72°F in ten minutes on 2026-11-16, felt as the bed turning cool on getting in.
// So the difference fades out with this time constant, and cooling by the proportional term fades in as
// it does. comfortDB `surfaceControl.entryHandoffMinutes`; 0 = switch at once, as before.
const HANDOFF_DEFAULT_MINUTES = 20;
// Over once this little of the difference is left (three time constants; ~0.4°F, one firmware level)
const HANDOFF_END_SHARE = 0.05;
// Getting in follows an empty-bed water target at most this old (the loop runs every minute)
const EMPTY_WATER_FRESH_MS = 3 * 60 * 1000;
// Probe 'body': the bed temperature is the probes weighted by where capacitance finds the sleeper.
// Below this summed rise over the empty-bed baseline there's no reliable position (the stream's
// CapPresence stays confirmed down to the same level), so the center probe is used.
const BODY_MIN_RISE = 1000;
// The stream saves the baseline every 15 min; much older means it isn't running
const CAP_BASELINE_MAX_AGE_S = 24 * 60 * 60;
// Logged when the sleeper moves this far, on the position scale below
const POSITION_SHIFT = 0.5;
// Capacitance briefly losing the sleeper would otherwise jump the reading ~2°F to the center probe
const POSITION_HOLD_MS = 10 * 60 * 1000;
const samples = { left: [], right: [] };
const roomSamples = [];
// Last minute each side was seen occupied; the server start counts, since presence is unknown until the
// stream reports
const startedAt = Date.now();
const lastPresentAt = { left: startedAt, right: startedAt };
// The empty-bed water last aimed at, and the last measured water temperature
const emptyWater = {};
const measuredWater = {};
// Last water target the firmware reported, per side (noted by loadDeviceStatus)
const waterTarget = {};
export const bedControlEnabled = () => comfortDB.data.surfaceControl?.enabled === true;
const clampF = (f) => Math.min(MAX_TARGET_F, Math.max(MIN_TARGET_F, f));
// Share of the body over each zone. Rises are squared because a body also raises the zones next to
// it: on 2026-10-31 lying over `in` raised it 2588 and `cen` 1154, while `in` read 3°F above `cen`.
export const bodyWeights = (cap, baseline) => {
    const rise = {
        out: Math.max(cap.out - baseline.out, 0),
        cen: Math.max(cap.cen - baseline.cen, 0),
        in: Math.max(cap.in - baseline.in, 0),
    };
    if (rise.out + rise.cen + rise.in < BODY_MIN_RISE)
        return null;
    const total = rise.out ** 2 + rise.cen ** 2 + rise.in ** 2;
    return { out: rise.out ** 2 / total, cen: rise.cen ** 2 / total, in: rise.in ** 2 / total };
};
const capBaseline = (side) => {
    try {
        const state = JSON.parse(fs.readFileSync(`${config.dbFolder}cap-baseline-${side}.json`, 'utf8'));
        if (Date.now() / 1000 - state.saved_at > CAP_BASELINE_MAX_AGE_S)
            return null;
        const { out, cen, in: inner } = state.baseline;
        return [out, cen, inner].every(Number.isFinite) ? { out, cen, in: inner } : null;
    }
    catch {
        return null;
    }
};
// Where the sleeper is, -1 (outer edge) to +1 (middle of the bed), while the side is occupied
const position = {};
const lastWeights = {};
const notePosition = (side, weights) => {
    const now = weights.in - weights.out;
    const last = position[side];
    if (last !== undefined && Math.abs(now - last) < POSITION_SHIFT)
        return;
    position[side] = now;
    const percent = (w) => Math.round(w * 100);
    logger.info(`BedControl: ${side} body position out ${percent(weights.out)}% cen ${percent(weights.cen)}% in ${percent(weights.in)}%`);
};
const bodyValue = (side, zones, cap) => {
    const baseline = isPresent(side) && cap ? capBaseline(side) : null;
    const weights = baseline && cap ? bodyWeights(cap, baseline) : null;
    const now = Date.now();
    if (weights) {
        notePosition(side, weights);
        lastWeights[side] = { weights, at: now };
    }
    const held = lastWeights[side];
    if (!held || now - held.at > POSITION_HOLD_MS) {
        delete position[side];
        delete lastWeights[side];
        return zones.cen;
    }
    return held.weights.out * zones.out + held.weights.cen * zones.cen + held.weights.in * zones.in;
};
const probeValue = (side, zones, cap) => {
    switch (comfortDB.data.surfaceControl?.probe) {
        case 'body': return bodyValue(side, zones, cap);
        case 'avg': return (zones.out + zones.cen + zones.in) / 3;
        case 'max': return Math.max(zones.out, zones.cen, zones.in);
        case 'min': return Math.min(zones.out, zones.cen, zones.in);
        default: return zones.cen;
    }
};
// Called every minute with the latest RAW sensor snapshot
export const sampleSurface = (sensors) => {
    const now = Date.now();
    if (sensors?.surfaceF && now / 1000 - sensors.ts < SURFACE_STALE_SECONDS) {
        samples.left.push({ at: now, f: probeValue('left', sensors.surfaceF.left, sensors.capacitance?.left) });
        samples.right.push({ at: now, f: probeValue('right', sensors.surfaceF.right, sensors.capacitance?.right) });
    }
    if (typeof sensors?.roomF === 'number' && now / 1000 - sensors.ts < SURFACE_STALE_SECONDS)
        roomSamples.push({ at: now, f: sensors.roomF });
    if (sensors?.waterF && now / 1000 - sensors.ts < SURFACE_STALE_SECONDS) {
        measuredWater.left = { at: now, f: sensors.waterF.left };
        measuredWater.right = { at: now, f: sensors.waterF.right };
    }
    while (roomSamples.length && now - roomSamples[0].at > ROOM_WINDOW_MS)
        roomSamples.shift();
    for (const side of ['left', 'right']) {
        while (samples[side].length && now - samples[side][0].at > SURFACE_WINDOW_MS)
            samples[side].shift();
        if (isPresent(side))
            lastPresentAt[side] = now;
    }
};
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
// Room temperature, 30-min median (winter heating cycles swing it ~1°F within the hour)
const roomF = () => (roomSamples.length ? median(roomSamples.map(s => s.f)) : null);
const settledEmpty = (side) => !isPresent(side) && Date.now() - lastPresentAt[side] >= EMPTY_AFTER_MS;
// Current bed temperature for a side, or null when there is no fresh reading
export const bedTemperatureF = (side) => {
    if (samples[side].length === 0) {
        try {
            sampleSurface(readLatestSensors());
        }
        catch {
            return null;
        }
    }
    if (samples[side].length === 0)
        return null;
    return Math.round(median(samples[side].map(s => s.f)) * 10) / 10;
};
const readState = () => {
    try {
        return JSON.parse(fs.readFileSync(BED_STATE, 'utf8'));
    }
    catch {
        return {};
    }
};
const writeState = (state) => {
    try {
        fs.writeFileSync(BED_STATE, JSON.stringify(state));
    }
    catch (error) {
        logger.warn(`BedControl: could not write state: ${error instanceof Error ? error.message : String(error)}`);
    }
};
export const noteWaterTarget = (side, level) => {
    waterTarget[side] = { level, f: levelToF(level) };
};
export const waterTargetLevel = (side) => waterTarget[side]?.level ?? null;
export const bedSetpointF = (side) => readState()[side]?.setpointF ?? null;
const feedForwardF = (setpointF) => setpointF + FEED_FORWARD_SLOPE * (setpointF - FEED_FORWARD_REFERENCE_F);
// Proportional term: only while someone is in bed, since an empty bed reads ~3°F cooler at the same water
export const bedProportionalF = (side, setpointF) => {
    const bedF = isPresent(side) ? bedTemperatureF(side) : null;
    if (bedF === null)
        return 0;
    return Math.max(-MAX_PROPORTIONAL_F, Math.min(MAX_PROPORTIONAL_F, PROPORTIONAL_GAIN * (setpointF - bedF)));
};
// Water that brings an empty bed to its setpoint, between the occupied-bed water and setpoint + 4°F
export const emptyBedWaterF = (bed, room) => {
    const occupiedF = feedForwardF(bed.setpointF) + bed.offsetF;
    if (room === null)
        return occupiedF;
    const wantedF = (bed.setpointF - EMPTY_BED_INTERCEPT_F - EMPTY_BED_ROOM * room) / EMPTY_BED_WATER;
    return Math.max(occupiedF, Math.min(bed.setpointF + EMPTY_MAX_ABOVE_SETPOINT_F, wantedF));
};
const handoffMinutes = () => {
    const minutes = comfortDB.data.surfaceControl?.entryHandoffMinutes;
    return typeof minutes === 'number' && minutes >= 0 ? minutes : HANDOFF_DEFAULT_MINUTES;
};
// Share of a handoff's extra water still applied (1 on getting in, fading to 0), or null when none is
// running
const handoffShare = (handoff) => {
    const minutes = handoffMinutes();
    if (!handoff || minutes === 0)
        return null;
    const ageMinutes = (Date.now() - handoff.at) / 60_000;
    if (ageMinutes < 0)
        return null;
    const share = Math.exp(-ageMinutes / minutes);
    return share >= HANDOFF_END_SHARE ? share : null;
};
// Someone got into a bed whose water was aimed at the empty bed: start the handoff from the water as it
// is (the measured one when lower: the pre-warm may only just have started)
const startHandoff = (side) => {
    const empty = emptyWater[side];
    if (!empty || !isPresent(side))
        return;
    delete emptyWater[side];
    const now = Date.now();
    if (now - empty.at > EMPTY_WATER_FRESH_MS || handoffMinutes() === 0)
        return;
    const state = readState();
    const bed = state[side];
    if (!bed)
        return;
    const measured = measuredWater[side];
    const fromF = measured && now - measured.at <= EMPTY_WATER_FRESH_MS ? Math.min(empty.f, measured.f) : empty.f;
    const occupiedF = feedForwardF(bed.setpointF) + bed.offsetF;
    const extraF = Math.round(Math.max(0, fromF - occupiedF) * 100) / 100;
    state[side] = { ...bed, handoff: { at: now, extraF } };
    writeState(state);
    logger.info(`BedControl: ${side} got in, easing the water from ${fromF.toFixed(1)}°F to the occupied-bed ${occupiedF.toFixed(1)}°F`
        + ` (${handoffMinutes()} min time constant)`);
};
const unclampedWaterF = (side, bed) => {
    if (settledEmpty(side)) {
        const waterF = emptyBedWaterF(bed, roomF());
        emptyWater[side] = { at: Date.now(), f: clampF(waterF) };
        return waterF;
    }
    const occupiedF = feedForwardF(bed.setpointF) + bed.offsetF;
    const proportionalF = bedProportionalF(side, bed.setpointF);
    const share = handoffShare(bed.handoff);
    if (share === null || !bed.handoff)
        return occupiedF + proportionalF;
    const extraF = bed.handoff.extraF * share;
    // A bed still short of its setpoint gets whichever is more, not both; a bed above it (body heat, at
    // first) is cooled only as far as the handoff has run
    return proportionalF >= 0
        ? occupiedF + Math.max(proportionalF, extraF)
        : occupiedF + extraF + proportionalF * (1 - share);
};
// What a running handoff adds to the water now (°F), and how much of the proportional term's cooling is
// applied; null when none is running
export const bedHandoff = (side) => {
    const bed = readState()[side];
    const share = settledEmpty(side) ? null : handoffShare(bed?.handoff);
    if (share === null || !bed?.handoff)
        return null;
    return { extraF: Math.round(bed.handoff.extraF * share * 100) / 100, share: Math.round(share * 100) / 100 };
};
export const bedIsSettledEmpty = settledEmpty;
// A side's setpoint and offset. The first time (bed control just switched on) it is seeded from the
// current bed temperature, with the offset that keeps the water where it is, so nothing moves.
export const bedSide = (side) => {
    startHandoff(side);
    const state = readState();
    const existing = state[side];
    if (existing)
        return existing;
    const bedF = bedTemperatureF(side);
    const water = waterTarget[side];
    if (bedF === null || !water)
        return null;
    const setpointF = clampF(Math.round(bedF));
    const seeded = { setpointF, offsetF: water.f - feedForwardF(setpointF) };
    state[side] = seeded;
    writeState(state);
    logger.info(`BedControl: ${side} bed setpoint seeded at ${setpointF}°F (bed ${bedF}°F, water ${water.f}°F)`);
    return seeded;
};
// The water target that holds a side's bed at its setpoint
export const bedWaterF = (side) => {
    const bed = bedSide(side);
    return bed ? clampF(unclampedWaterF(side, bed)) : null;
};
// New bed setpoint from the app, HA, a button or a schedule. Returns the water target to send.
export const setBedSetpoint = (side, setpointF) => {
    const current = bedSide(side);
    const updated = { ...current, setpointF: clampF(setpointF), offsetF: current?.offsetF ?? 0 };
    const state = readState();
    state[side] = updated;
    writeState(state);
    return clampF(unclampedWaterF(side, updated));
};
// How fast the bed is moving, for a side the loop is correcting (°F per min, averaged)
const trend = {};
const noteTrend = (side, bedF) => {
    const now = Date.now();
    const last = trend[side];
    // A gap means the side was empty or off, so the old reading says nothing about the bed now
    const rate = last && now - last.at <= 2 * 60 * 1000
        ? last.rate + ((bedF - last.bedF) - last.rate) / TREND_SMOOTHING_MINUTES
        : 0;
    trend[side] = { bedF, at: now, rate };
    return rate;
};
// One minute of the integral term for a side that is on and occupied. Returns what it did, or null
// when it left the offset alone.
export const correctBed = (side) => {
    const current = bedSide(side);
    const bedF = bedTemperatureF(side);
    if (!current || bedF === null)
        return null;
    const rate = noteTrend(side, bedF);
    const errorF = current.setpointF - bedF;
    // Not while getting in: the error then is body heat arriving, not a wrong offset
    if (handoffShare(current.handoff) !== null)
        return null;
    if (Math.abs(errorF) < INTEGRAL_DEADBAND_F || Math.abs(errorF) > INTEGRAL_MAX_ERROR_F)
        return null;
    if (errorF * rate > 0 && Math.abs(rate) >= INTEGRAL_APPROACH_RATE)
        return null;
    // At the Pod's range limit more offset does nothing, so don't let it pile up
    const waterF = unclampedWaterF(side, current);
    if (waterF !== clampF(waterF))
        return null;
    const offsetF = Math.max(-MAX_OFFSET_F, Math.min(MAX_OFFSET_F, current.offsetF + INTEGRAL_GAIN_PER_MIN * errorF));
    const state = readState();
    state[side] = { ...current, offsetF };
    writeState(state);
    return { setpointF: current.setpointF, bedF, offsetF };
};
//# sourceMappingURL=bedControl.js.map