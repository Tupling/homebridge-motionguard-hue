'use strict';

const { HueClient } = require('../lib/hue-client');

function safeMessage(error) {
  const text = String(error?.message || error || 'Hue Bridge request failed');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 400);
}

function buildClient(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return new HueClient({
    host: String(source.bridgeHost || '').trim(),
    applicationKey: String(source.hueApplicationKey || source.hueUsername || '').trim(),
    certificateFingerprint: String(source.certificateFingerprint || '').trim(),
    bridgeId: String(source.bridgeId || '').trim(),
    log: null,
  });
}

function publicLight(light) {
  return {
    id: light.id,
    id_v1: light.id_v1 || '',
    name: light.name || light.id,
    archetype: light.archetype || '',
    on: Boolean(light.state?.on),
    features: {
      dimming: Boolean(light.features?.dimming),
      colorTemperature: Boolean(light.features?.colorTemperature),
      color: Boolean(light.features?.color),
    },
  };
}

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class MotionGuardUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/discover-lights', this.discoverLights.bind(this));
      this.onRequest('/bridge-health', this.bridgeHealth.bind(this));
      this.ready();
    }

    async getInventory(payload) {
      try {
        const client = buildClient(payload);
        const lights = await client.getLights();
        const inventory = Object.values(lights)
          .map(publicLight)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return {
          online: true,
          checkedAt: new Date().toISOString(),
          lightCount: inventory.length,
          lights: inventory,
        };
      } catch (error) {
        throw new RequestError(safeMessage(error));
      }
    }

    async discoverLights(payload) {
      return await this.getInventory(payload);
    }

    async bridgeHealth(payload) {
      const result = await this.getInventory(payload);
      return {
        online: result.online,
        checkedAt: result.checkedAt,
        lightCount: result.lightCount,
      };
    }
  }

  return new MotionGuardUiServer();
})().catch((error) => {
  console.error(`MotionGuard for Hue UI server failed: ${safeMessage(error)}`);
  process.exitCode = 1;
});
