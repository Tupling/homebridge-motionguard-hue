'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMotionState,
  copySnapshotState,
  mergeV2LightUpdate,
  normalizeV2Light,
  percentToHueBrightness,
  stateLooksLikeMotion,
  v1LikeStateToV2,
} = require('../lib/hue-client');
const {
  effectiveLightSettings,
  normalizeZones,
  persistedToRuntime,
  runtimeToPersisted,
} = require('../lib/zones');

const GREEN = [0.17, 0.7];
const BLUE = [0.15, 0.08];

function hueResource({ on = true, brightness = 42, mirek = 250, mirekValid = false, xy = GREEN } = {}) {
  return {
    id: 'outdoor-spotlight-1',
    type: 'light',
    on: { on },
    dimming: { brightness },
    color_temperature: { mirek, mirek_valid: mirekValid, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
    color: xy ? { xy: { x: xy[0], y: xy[1] } } : undefined,
  };
}

test('Hue API v2: green XY is the active color even with a remembered mirek', () => {
  const light = normalizeV2Light(hueResource());
  assert.equal(light.state.colormode, 'xy');
  assert.deepEqual(copySnapshotState(light), {
    on: true, bri: percentToHueBrightness(42), xy: GREEN,
  });
});

test('Hue API v2: valid mirek selects CT even when a remembered XY is present', () => {
  const light = normalizeV2Light(hueResource({ mirekValid: true }));
  assert.equal(light.state.colormode, 'ct');
  assert.deepEqual(copySnapshotState(light), {
    on: true, bri: percentToHueBrightness(42), ct: 250,
  });
});

test('Hue API v2: null mirek is not interpreted as a valid 0-mirek temperature', () => {
  const light = normalizeV2Light(hueResource({ mirek: null, mirekValid: false }));
  assert.equal(light.state.colormode, 'xy');
  assert.equal(Object.hasOwn(light.state, 'ct'), false);
});

test('Hue event cache honors mirek_valid=true even when XY accompanies the event', () => {
  const initial = normalizeV2Light(hueResource());
  const updated = mergeV2LightUpdate(initial, {
    id: initial.id,
    on: { on: true },
    dimming: { brightness: 100 },
    color_temperature: { mirek: 200, mirek_valid: true },
    color: { xy: { x: GREEN[0], y: GREEN[1] } },
  });
  assert.equal(updated.state.colormode, 'ct');
  assert.equal(updated.state.ct, 200);
  assert.ok(stateLooksLikeMotion(updated.state, buildMotionState(initial, 100, 200, 'white')));
});

test('Hue event cache honors mirek_valid=false even when mirek accompanies the event', () => {
  const initial = normalizeV2Light(hueResource({ mirekValid: true }));
  const updated = mergeV2LightUpdate(initial, {
    id: initial.id,
    color_temperature: { mirek: 200, mirek_valid: false },
    color: { xy: { x: GREEN[0], y: GREEN[1] } },
  });
  assert.equal(updated.state.colormode, 'xy');
  assert.deepEqual(updated.state.xy, GREEN);
});

test('Hue dimming-only event leaves the active color mode unchanged', () => {
  const initial = normalizeV2Light(hueResource());
  const updated = mergeV2LightUpdate(initial, {
    id: initial.id, dimming: { brightness: 65 },
  });
  assert.equal(updated.state.colormode, 'xy');
  assert.deepEqual(updated.state.xy, GREEN);
});

test('Preserve Color: motion keeps green and changes brightness only', () => {
  const light = normalizeV2Light(hueResource());
  const desired = buildMotionState(light, 100, 200, 'preserve');
  assert.deepEqual(desired, { on: true, bri: 254, transitiontime: 0, xy: GREEN });
  assert.equal(Object.hasOwn(desired, 'ct'), false);
  const after = { on: true, bri: 254, colormode: 'xy', xy: GREEN };
  assert.ok(stateLooksLikeMotion(after, desired));
});

test('Preserve Color: off light remembers its green XY and can return to off', () => {
  const light = normalizeV2Light(hueResource({ on: false }));
  const before = copySnapshotState(light);
  const desired = buildMotionState(light, 65, 200, 'preserve');
  assert.deepEqual(desired.xy, GREEN);
  assert.equal(desired.on, true);
  assert.equal(before.on, false);
  const restoration = v1LikeStateToV2(before);
  assert.deepEqual(restoration.on, { on: false });
  assert.deepEqual(restoration.color.xy, { x: GREEN[0], y: GREEN[1] });
});

test('Preserve Color: white-temperature light remains on its original warm white', () => {
  const light = normalizeV2Light(hueResource({ mirekValid: true, mirek: 400, on: false }));
  const desired = buildMotionState(light, 80, 200, 'preserve');
  assert.equal(desired.ct, 400);
  assert.equal(Object.hasOwn(desired, 'xy'), false);
  assert.ok(stateLooksLikeMotion(
    { on: true, bri: desired.bri, colormode: 'ct', ct: 400 }, desired,
  ));
});

test('Preserve Color: unknown color is not replaced with bright white', () => {
  const light = normalizeV2Light(hueResource({ mirek: null, mirekValid: false, xy: null }));
  const desired = buildMotionState(light, 70, 200, 'preserve');
  assert.equal(Object.hasOwn(desired, 'ct'), false);
  assert.equal(Object.hasOwn(desired, 'xy'), false);
});

test('Bright White remains the legacy default and checks the white mode', () => {
  const light = normalizeV2Light(hueResource());
  const desired = buildMotionState(light, 100, 200);
  assert.equal(desired.ct, 200);
  assert.equal(Object.hasOwn(desired, 'xy'), false);
  assert.ok(stateLooksLikeMotion(
    { on: true, bri: 254, colormode: 'ct', ct: 202 }, desired,
  ));
  assert.equal(stateLooksLikeMotion(
    { on: true, bri: 254, colormode: 'xy', ct: 200, xy: GREEN }, desired,
  ), false);
});

test('Restore verification protects a genuine color change during motion', () => {
  const light = normalizeV2Light(hueResource());
  const desired = buildMotionState(light, 100, 200, 'preserve');
  assert.equal(stateLooksLikeMotion(
    { on: true, bri: desired.bri, colormode: 'xy', xy: BLUE }, desired,
  ), false);
  assert.equal(stateLooksLikeMotion(
    { on: true, bri: desired.bri, colormode: 'ct', ct: 200 }, desired,
  ), false);
});

test('Restore verification protects brightness changes and unknown Hue color mode', () => {
  const desired = buildMotionState(normalizeV2Light(hueResource()), 100, 200, 'preserve');
  assert.equal(stateLooksLikeMotion({ on: true, bri: 150, colormode: 'xy', xy: GREEN }, desired), false);
  assert.equal(stateLooksLikeMotion({ on: true, bri: 254, xy: GREEN }, desired), false);
});

test('Restore: saved XY color is converted back to the Hue API v2 color command', () => {
  const previous = copySnapshotState(normalizeV2Light(hueResource()));
  const restored = v1LikeStateToV2(previous);
  assert.deepEqual(restored.color.xy, { x: GREEN[0], y: GREEN[1] });
  assert.equal(Object.hasOwn(restored, 'color_temperature'), false);
});

test('Zone normalization keeps existing zones bright white, new explicit modes survive', () => {
  const zones = normalizeZones({
    zoneManagerVersion: 2,
    zones: [
      { id: 'garage', name: 'Garage', lights: ['outdoor-spotlight-1'] },
      { id: 'patio', name: 'Patio', lights: ['test'], colorMode: 'preserve' },
      { id: 'side', name: 'Side', lights: ['test'], colorMode: 'invalid' },
    ],
  });
  assert.equal(zones[0].colorMode, 'white');
  assert.equal(zones[1].colorMode, 'preserve');
  assert.equal(zones[2].colorMode, 'white');
  assert.equal(effectiveLightSettings(zones[1], {}, 'normal').colorMode, 'preserve');
  assert.equal(effectiveLightSettings(zones[0], {}, 'normal').colorMode, 'white');
});

test('Legacy single-zone configuration retains white until migrated', () => {
  const [zone] = normalizeZones({ lights: ['outdoor-spotlight-1'] });
  assert.equal(effectiveLightSettings(zone, {}, 'normal').colorMode, 'white');
});

test('Restart recovery retains XY snapshots and expected motion states', () => {
  const light = normalizeV2Light(hueResource());
  const snapshot = new Map([['outdoor-spotlight-1', {
    name: 'Outdoor Spotlight 1', state: copySnapshotState(light),
  }]]);
  const expectedStates = new Map([['outdoor-spotlight-1', buildMotionState(light, 100, 200, 'preserve')]]);
  const now = Date.now();
  const saved = runtimeToPersisted({
    snapshot, expectedStates, overrideStartedAt: now,
    restoreAt: now + 5000, hardStopAt: now + 60000,
  });
  const recovered = persistedToRuntime('garage', saved);
  assert.deepEqual(recovered.snapshot.get('outdoor-spotlight-1').state.xy, GREEN);
  assert.deepEqual(recovered.expectedStates.get('outdoor-spotlight-1').xy, GREEN);
});
