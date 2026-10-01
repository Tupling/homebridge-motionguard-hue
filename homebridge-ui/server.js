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
    ownerId: light.owner?.rid || '',
    ownerType: light.owner?.rtype || '',
    serviceId: Number.isFinite(light.serviceId) ? light.serviceId : null,
    serviceName: light.serviceName || light.name || light.id,
    serviceArchetype: light.serviceArchetype || '',
    serviceFunction: light.serviceFunction || '',
    serviceAssociation: light.serviceAssociation || '',
    on: Boolean(light.state?.on),
    features: {
      dimming: Boolean(light.features?.dimming),
      colorTemperature: Boolean(light.features?.colorTemperature),
      color: Boolean(light.features?.color),
    },
  };
}

function publicFixture(fixture) {
  return {
    id: fixture.id,
    name: fixture.name || fixture.id,
    archetype: fixture.archetype || '',
    product: fixture.product || {},
    multiService: Boolean(fixture.multiService),
    lightServiceCount: Number(fixture.lightServiceCount || fixture.lightServices?.length || 0),
    unresolvedOwner: Boolean(fixture.unresolvedOwner),
    lightServices: (fixture.lightServices || []).map(publicLight),
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
        const inventory = await client.getDeviceInventory();
        const lights = Object.values(inventory.lights)
          .map(publicLight)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const fixtures = (inventory.fixtures || []).map(publicFixture);
        return {
          online: true,
          checkedAt: new Date().toISOString(),
          lightCount: lights.length,
          fixtureCount: fixtures.length,
          multiServiceFixtureCount: fixtures.filter((fixture) => fixture.multiService).length,
          lights,
          fixtures,
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
        fixtureCount: result.fixtureCount,
        multiServiceFixtureCount: result.multiServiceFixtureCount,
      };
    }
  }

  return new MotionGuardUiServer();
})().catch((error) => {
  console.error(`MotionGuard for Hue UI server failed: ${safeMessage(error)}`);
  process.exitCode = 1;
});
