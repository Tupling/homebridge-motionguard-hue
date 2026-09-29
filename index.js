'use strict';

const { MotionGuardPlatform } = require('./lib/platform');

const PLUGIN_NAME = 'homebridge-hue-motion-restore';
const PLATFORM_NAME = 'HueMotionRestore';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MotionGuardPlatform);
};

module.exports.MotionGuardPlatform = MotionGuardPlatform;
