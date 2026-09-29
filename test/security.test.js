'use strict';

const assert = require('node:assert/strict');
const {
  isPrivateBridgeAddress,
  normalizeFingerprint,
  validateSecurityConfig,
  v1LikeStateToV2,
} = require('../lib/hue-client');

assert.equal(isPrivateBridgeAddress('192.168.1.25'), true);
assert.equal(isPrivateBridgeAddress('10.0.0.2'), true);
assert.equal(isPrivateBridgeAddress('172.16.0.2'), true);
assert.equal(isPrivateBridgeAddress('8.8.8.8'), false);
assert.equal(isPrivateBridgeAddress('example.com'), false);

const fingerprint = Array(32).fill('AA').join(':');
assert.equal(normalizeFingerprint(fingerprint.toLowerCase()), fingerprint);

assert.throws(() => validateSecurityConfig({
  host: '8.8.8.8',
  applicationKey: 'secret',
  certificateFingerprint: fingerprint,
  bridgeId: '001788FFFE123456',
}), /private or link-local/);

assert.throws(() => validateSecurityConfig({
  host: '192.168.1.25',
  applicationKey: '',
  certificateFingerprint: fingerprint,
  bridgeId: '001788FFFE123456',
}), /application key is required/);

assert.deepEqual(validateSecurityConfig({
  host: '192.168.1.25',
  applicationKey: 'secret',
  certificateFingerprint: fingerprint,
  bridgeId: '001788FFFE123456',
}), {
  fingerprint,
  bridgeId: '001788FFFE123456',
});

const hueBody = v1LikeStateToV2({ on: true, bri: 254, ct: 200 });
assert.equal(JSON.stringify(hueBody).includes('secret'), false);
assert.equal(JSON.stringify(hueBody).includes('applicationKey'), false);

console.log('security tests passed');
