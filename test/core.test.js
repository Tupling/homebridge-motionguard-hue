'use strict';

const assert = require('node:assert/strict');
const {
  mergeV2LightUpdate,
  normalizeV2Light,
  percentToHueBrightness,
  stateLooksLikeMotion,
  v1LikeStateToV2,
} = require('../lib/hue-client');
const {
  normalizeZones,
  persistedToRuntime,
  runtimeToPersisted,
} = require('../lib/zones');

assert.equal(percentToHueBrightness(100), 254);
assert.equal(percentToHueBrightness(1), 3);

const existing = {
  id: 'light-1',
  name: 'Porch',
  state: { on: false, bri: 127, ct: 250, colormode: 'ct' },
  features: { dimming: true, colorTemperature: true, color: false },
  capabilities: { control: { ct: { min: 153, max: 500 } } },
};
const merged = mergeV2LightUpdate(existing, {
  id: 'light-1',
  type: 'light',
  on: { on: true },
  dimming: { brightness: 80 },
});
assert.equal(merged.state.on, true);
assert.equal(merged.state.ct, 250);
assert.equal(merged.state.colormode, 'ct');
assert.equal(merged.state.bri, percentToHueBrightness(80));

const nullTemperatureEvent = mergeV2LightUpdate(merged, {
  id: 'light-1',
  type: 'light',
  color_temperature: { mirek: null, mirek_valid: false },
});
assert.equal(nullTemperatureEvent.state.ct, 250);
assert.equal(nullTemperatureEvent.state.colormode, 'ct');

const normalizedWithoutTemperature = normalizeV2Light({
  id: 'light-2',
  type: 'light',
  on: { on: false },
  dimming: { brightness: null },
  color_temperature: { mirek: null, mirek_valid: false },
});
assert.equal(Object.hasOwn(normalizedWithoutTemperature.state, 'ct'), false);
assert.equal(Object.hasOwn(normalizedWithoutTemperature.state, 'bri'), false);

assert.deepEqual(v1LikeStateToV2({ on: true, bri: 254, ct: 200, transitiontime: 0 }), {
  on: { on: true },
  dimming: { brightness: 100 },
  color_temperature: { mirek: 200 },
  dynamics: { duration: 0 },
});
assert.equal(stateLooksLikeMotion({ on: true, bri: 252, ct: 205, colormode: 'ct' }, { on: true, bri: 254, ct: 200 }), true);
assert.equal(stateLooksLikeMotion({ on: true, bri: 200, ct: 205, colormode: 'ct' }, { on: true, bri: 254, ct: 200 }), false);

const zones = normalizeZones({
  zoneManagerVersion: 1,
  zones: [{
    id: 'front-porch',
    name: 'Front Porch',
    lights: ['Porch Left', 'Porch Right'],
    primary: true,
    legacyTrigger: true,
    protectManualChanges: false,
  }],
});
assert.equal(zones.length, 1);
assert.equal(zones[0].legacyTrigger, true);
assert.equal(zones[0].protectManualChanges, false);

const runtime = {
  snapshot: new Map([['light-1', { state: { on: false, bri: 127 } }]]),
  expectedStates: new Map([['light-1', { on: true, bri: 254, ct: 200 }]]),
  overrideStartedAt: 100,
  restoreAt: 200,
  hardStopAt: 300,
};
const persisted = runtimeToPersisted(runtime);
const restored = persistedToRuntime('front-porch', persisted);
assert.equal(restored.zoneId, 'front-porch');
assert.deepEqual(restored.snapshot.get('light-1'), { state: { on: false, bri: 127 } });
assert.deepEqual(restored.expectedStates.get('light-1'), { on: true, bri: 254, ct: 200 });

console.log('core tests passed');
