'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const shrinkwrap = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'config.schema.json'), 'utf8'));

assert.equal(packageJson.version, '0.7.0');
assert.equal(shrinkwrap.version, packageJson.version);
assert.equal(shrinkwrap.packages[''].version, packageJson.version);
assert.equal(schema.pluginAlias, 'HueMotionRestore');
assert.equal(schema.pluginType, 'platform');
assert.equal(schema.customUi, true);
assert.equal(fs.existsSync(path.join(root, 'index.js')), true);
assert.equal(fs.existsSync(path.join(root, 'homebridge-ui', 'public', 'index.html')), true);
assert.equal(fs.existsSync(path.join(root, 'homebridge-ui', 'server.js')), true);
assert.equal(fs.existsSync(path.join(root, 'lib', 'platform.js')), true);
assert.equal(fs.existsSync(path.join(root, 'lib', 'homekit-controls.js')), true);

console.log('packaging tests passed');
