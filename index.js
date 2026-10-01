'use strict';

const {
  HueClient,
  buildMotionState,
  copySnapshotState,
  sanitizeRestoreState,
  stateLooksLikeMotion,
} = require('./lib/hue-client');
const { getSunTimes, isNight } = require('./lib/sun');
const {
  effectiveLightSettings,
  effectiveZoneSettings,
  normalizeZones,
  persistedToRuntime,
  runtimeToPersisted,
} = require('./lib/zones');

const PLUGIN_NAME = 'homebridge-hue-motion-restore';
const PLATFORM_NAME = 'HueMotionRestore';

const SETTINGS_UUID_SEED = 'hue-motion-restore:settings';
const TRIGGER_UUID_SEED = 'hue-motion-restore:ring-motion-pulse';

const DELAY_PRESETS = [
  { seconds: 30, name: 'Restore 30 Seconds', subtype: 'delay-30' },
  { seconds: 60, name: 'Restore 60 Seconds', subtype: 'delay-60' },
  { seconds: 90, name: 'Restore 90 Seconds', subtype: 'delay-90' },
  { seconds: 120, name: 'Restore 2 Minutes', subtype: 'delay-120' },
  { seconds: 300, name: 'Restore 5 Minutes', subtype: 'delay-300' },
];

const SECURITY_MODES = [
  { value: 'normal', name: 'Security Normal', subtype: 'security-normal' },
  { value: 'night', name: 'Security Night', subtype: 'security-night' },
  { value: 'away', name: 'Security Away', subtype: 'security-away' },
  { value: 'party', name: 'Security Party', subtype: 'security-party' },
];

const HOMEKIT_PROFILES = new Set(['minimal', 'standard', 'advanced']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HueMotionRestorePlatform);
};

class HueMotionRestorePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.cachedAccessories = new Map();

    this.hue = null;
    this.settingsAccessory = null;
    this.zones = [];
    this.zoneMap = new Map();
    this.primaryZoneId = null;
    this.zoneRuntimes = new Map();
    this.zoneAccessories = new Map();
    this.bridgeHealth = {
      online: false,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastError: '',
      lightCount: 0,
    };
    this.pauseTimers = new Map();

    this.api.on('didFinishLaunching', () => {
      this.discoverAndConfigure().catch((error) => {
        this.log.error(`Startup failed: ${error.message}`);
      });
    });

    this.api.on('shutdown', () => {
      this.clearAllRuntimeTimers();
      this.clearAllPauseTimers();
        this.hue?.stopEventStream?.();
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  async discoverAndConfigure() {
    if (!this.config.bridgeHost || !(this.config.hueApplicationKey || this.config.hueUsername) || !this.config.certificateFingerprint || !this.config.bridgeId) {
      this.log.error('Secure Hue configuration is incomplete. Bridge host, application key, Bridge ID, and certificate fingerprint are required.');
      return;
    }

    try {
      this.zones = normalizeZones(this.config);
    } catch (error) {
      this.log.error(`Zone configuration is invalid: ${error.message}`);
      return;
    }

    if (!this.zones.length) {
      this.log.error('No Hue lights are configured. Configure either the legacy Exterior Hue Lights list or at least one zone.');
      return;
    }

    this.zoneMap = new Map(this.zones.map((zone) => [zone.id, zone]));
    const preferredPrimary = this.zones.find(
      (zone) => zone.primary && zone.enabled && zone.lights.length,
    );
    const firstReadyZone = this.zones.find((zone) => zone.enabled && zone.lights.length);
    this.primaryZoneId = preferredPrimary?.id
      || firstReadyZone?.id
      || this.zones.find((zone) => zone.primary)?.id
      || this.zones[0].id;

    this.hue = new HueClient({
      host: this.config.bridgeHost,
      applicationKey: this.config.hueApplicationKey || this.config.hueUsername,
      certificateFingerprint: this.config.certificateFingerprint,
      bridgeId: this.config.bridgeId,
      log: this.log,
    });

    const legacySettingsUuid = this.api.hap.uuid.generate(SETTINGS_UUID_SEED);
    const legacySettingsAccessory = this.cachedAccessories.get(legacySettingsUuid) || null;

    this.setupZoneControllerAccessories(legacySettingsAccessory);
    this.clearRetiredDirectRingState();
    this.logRuntimeDiagnostics();
    await this.logHueZoneInventory();
    this.hue.startEventStream();
    await this.recoverPersistedOverrides();
    this.armAllPauseTimers();
  }

  clearRetiredDirectRingState() {
    if (!this.settingsAccessory?.context?.directRingRefreshToken) return;
    delete this.settingsAccessory.context.directRingRefreshToken;
    this.api.updatePlatformAccessories([this.settingsAccessory]);
    this.log.info('Removed retired Direct Ring credential from Homebridge accessory context.');
  }

  getOrCreateAccessory(seed, displayName) {
    const uuid = this.api.hap.uuid.generate(seed);
    let accessory = this.cachedAccessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory);
      this.log.info(`Added HomeKit accessory: ${displayName}`);
    } else if (accessory.displayName !== displayName) {
      accessory.displayName = displayName;
      this.api.updatePlatformAccessories([accessory]);
    }

    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Local Homebridge')
      .setCharacteristic(this.Characteristic.Model, 'MotionGuard for Hue')
      .setCharacteristic(this.Characteristic.SerialNumber, seed);

    return accessory;
  }

  defaultSettings() {
    return {
      enabled: true,
      brightness: 100,
      colorTemperature: 200,
      nightOnly: false,
      protectManualChanges: true,
      delaySeconds: 90,
      securityMode: 'normal',
      pausedUntil: 0,
    };
  }

  get settings() {
    const current = this.settingsAccessory?.context?.motionSettings || {};
    return { ...this.defaultSettings(), ...current };
  }

  configuredGlobalSettings() {
    const next = {};
    if (Number.isFinite(Number(this.config.brightness))) {
      next.brightness = Math.min(100, Math.max(1, Number(this.config.brightness)));
    }
    if (Number.isFinite(Number(this.config.colorTemperature))) {
      next.colorTemperature = Math.round(Math.min(500, Math.max(153, Number(this.config.colorTemperature))));
    }
    if (Number.isFinite(Number(this.config.delaySeconds))) {
      next.delaySeconds = Math.round(Math.min(3600, Math.max(5, Number(this.config.delaySeconds))));
    }
    if (typeof this.config.nightOnly === 'boolean') next.nightOnly = this.config.nightOnly;
    if (typeof this.config.protectManualChanges === 'boolean') next.protectManualChanges = this.config.protectManualChanges;
    if (['normal', 'night', 'away', 'party'].includes(this.config.securityMode)) next.securityMode = this.config.securityMode;
    return next;
  }

  syncConfiguredSettings() {
    if (!this.settingsAccessory) return;
    const configured = this.configuredGlobalSettings();
    const signature = JSON.stringify(configured);
    if (this.settingsAccessory.context.motionSettingsConfigSignature === signature) return;

    const current = this.settingsAccessory.context.motionSettings || this.defaultSettings();
    this.settingsAccessory.context.motionSettings = { ...current, ...configured };
    this.settingsAccessory.context.motionSettingsConfigSignature = signature;
    this.api.updatePlatformAccessories([this.settingsAccessory]);
  }

  persistSettings(patch) {
    if (!this.settingsAccessory) return { ...this.defaultSettings(), ...patch };
    const next = { ...this.settings, ...patch };
    this.settingsAccessory.context.motionSettings = next;
    this.api.updatePlatformAccessories([this.settingsAccessory]);
    if (this.config.debug) this.log.info(`Settings updated: ${JSON.stringify(next)}`);
    return next;
  }

  homekitProfile() {
    const value = String(this.config.homekitProfile || 'standard').toLowerCase();
    return HOMEKIT_PROFILES.has(value) ? value : 'standard';
  }

  pauseDurationMinutes() {
    const value = Number(this.config.pauseDurationMinutes || 60);
    if (!Number.isFinite(value)) return 60;
    return Math.min(1440, Math.max(5, Math.round(value)));
  }

  defaultZoneControls(zone) {
    return {
      enabled: zone?.enabled !== false,
      nightOnly: typeof zone?.nightOnly === 'boolean' ? zone.nightOnly : Boolean(this.settings.nightOnly),
      pausedUntil: 0,
    };
  }

  zoneControls(zoneOrId) {
    const zone = typeof zoneOrId === 'string' ? this.zoneMap.get(zoneOrId) : zoneOrId;
    if (!zone) return { enabled: false, nightOnly: false, pausedUntil: 0 };
    const accessory = this.zoneAccessories.get(zone.id);
    const current = accessory?.context?.zoneControls || {};
    return { ...this.defaultZoneControls(zone), ...current };
  }

  persistZoneControls(zoneId, patch) {
    const zone = this.zoneMap.get(zoneId);
    const accessory = this.zoneAccessories.get(zoneId);
    if (!zone || !accessory) return this.zoneControls(zone);
    const next = { ...this.zoneControls(zone), ...patch };
    accessory.context.zoneControls = next;
    this.api.updatePlatformAccessories([accessory]);
    if (this.config.debug) this.log.info(`Zone controls updated for "${zone.name}": ${JSON.stringify(next)}`);
    return next;
  }

  migrateLegacySettingsAccessory(legacyAccessory) {
    if (!this.settingsAccessory) return;

    if (!this.settingsAccessory.context.motionSettings) {
      this.settingsAccessory.context.motionSettings = {
        ...this.defaultSettings(),
        ...(legacyAccessory?.context?.motionSettings || {}),
      };
    }
    if (!this.settingsAccessory.context.activeOverrides || typeof this.settingsAccessory.context.activeOverrides !== 'object') {
      this.settingsAccessory.context.activeOverrides = {
        ...(legacyAccessory?.context?.activeOverrides || {}),
      };
    }

    const legacySettings = legacyAccessory?.context?.motionSettings || null;
    if (legacySettings) {
      for (const zone of this.zones) {
        const zoneAccessory = this.zoneAccessories.get(zone.id);
        if (!zoneAccessory || zoneAccessory.context.zoneControls) continue;
        zoneAccessory.context.zoneControls = {
          enabled: legacySettings.enabled !== false && zone.enabled !== false,
          nightOnly: typeof zone.nightOnly === 'boolean'
            ? zone.nightOnly
            : (typeof legacySettings.nightOnly === 'boolean'
              ? legacySettings.nightOnly
              : this.defaultZoneControls(zone).nightOnly),
          pausedUntil: Number(legacySettings.pausedUntil || 0),
        };
        this.api.updatePlatformAccessories([zoneAccessory]);
      }
    }

    this.syncConfiguredSettings();
    this.api.updatePlatformAccessories([this.settingsAccessory]);

    if (legacyAccessory && legacyAccessory.UUID !== this.settingsAccessory.UUID) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [legacyAccessory]);
      this.cachedAccessories.delete(legacyAccessory.UUID);
      this.log.info('Migrated the legacy MotionGuard settings accessory into the primary zone controller.');
    }
  }

  setupZoneControllerAccessories(legacySettingsAccessory = null) {
    const desired = new Set();
    this.zoneAccessories.clear();

    for (const zone of this.zones) {
      const seed = zone.legacyTrigger
        ? TRIGGER_UUID_SEED
        : `hue-motion-restore:zone-trigger:${zone.id}`;
      const displayName = `MotionGuard — ${zone.name}`;
      const accessory = this.getOrCreateAccessory(seed, displayName);
      accessory.context.hmrRole = 'zone-controller';
      accessory.context.zoneId = zone.id;
      this.zoneAccessories.set(zone.id, accessory);
      desired.add(accessory.UUID);
    }

    this.settingsAccessory = this.zoneAccessories.get(this.primaryZoneId) || null;
    this.migrateLegacySettingsAccessory(legacySettingsAccessory);

    for (const zone of this.zones) {
      const accessory = this.zoneAccessories.get(zone.id);
      this.setupZoneControllerAccessory(accessory, zone);
    }

    const stale = [];
    for (const accessory of this.cachedAccessories.values()) {
      if (['zone-trigger', 'zone-controller'].includes(accessory.context?.hmrRole) && !desired.has(accessory.UUID)) {
        stale.push(accessory);
      }
    }

    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) this.cachedAccessories.delete(accessory.UUID);
      this.log.info(`Removed ${stale.length} stale motion-zone controller accessory/accessories.`);
    }
  }

  setupZoneTriggerAccessories() {
    // Compatibility wrapper retained for older tests/integrations.
    this.setupZoneControllerAccessories(null);
  }

  setupZoneControllerAccessory(accessory, zone) {
    if (!accessory) return;
    const profile = this.homekitProfile();

    // Reuse the original switch service when upgrading so existing Apple Home
    // automations keep the exact Motion Pulse service identity.
    const triggerService = accessory.getServiceById(this.Service.Switch, 'zone-trigger')
      || accessory.getService(this.Service.Switch)
      || accessory.addService(this.Service.Switch, 'Motion Trigger', 'zone-trigger');
    this.applyServiceName(triggerService, 'Motion Trigger');
    triggerService.getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) return;
        try {
          await this.handleZoneMotionPulse(zone.id, `${zone.name}/HomeKit`, {
            bypassNightOnly: false,
            manualTest: false,
          });
        } finally {
          setTimeout(() => triggerService.updateCharacteristic(this.Characteristic.On, false), 600);
        }
      });

    const enabledService = this.getOrAddService(accessory, this.Service.Switch, 'Enabled', 'zone-enabled');
    enabledService.setPrimaryService(true);
    enabledService.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this.zoneControls(zone).enabled))
      .onSet(async (value) => {
        this.persistZoneControls(zone.id, { enabled: Boolean(value) });
        if (!value) await this.restoreZoneNow(zone.id, 'zone disabled from Apple Home');
      });

    const pauseService = this.getOrAddService(accessory, this.Service.Switch, 'Pause', 'zone-pause');
    pauseService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.isZonePaused(zone.id))
      .onSet((value) => this.handleZonePauseWrite(zone.id, Boolean(value)));

    if (profile === 'standard' || profile === 'advanced') {
      const nightService = this.getOrAddService(accessory, this.Service.Switch, 'Night Only', 'zone-night-only');
      nightService.getCharacteristic(this.Characteristic.On)
        .onGet(() => Boolean(this.zoneControls(zone).nightOnly))
        .onSet((value) => this.persistZoneControls(zone.id, { nightOnly: Boolean(value) }));

      const activityService = this.getOrAddService(
        accessory,
        this.Service.MotionSensor,
        'Override Active',
        'zone-active',
      );
      activityService.getCharacteristic(this.Characteristic.MotionDetected)
        .onGet(() => Boolean(this.zoneRuntimes.get(zone.id)?.snapshot));
    } else {
      this.removeServiceBySubtype(accessory, this.Service.Switch, 'zone-night-only');
      this.removeServiceBySubtype(accessory, this.Service.MotionSensor, 'zone-active');
    }

    if (profile === 'advanced') {
      const protectionService = this.getOrAddService(
        accessory,
        this.Service.Switch,
        'Protect Manual Changes',
        'zone-protect-manual',
      );
      protectionService.getCharacteristic(this.Characteristic.On)
        .onGet(() => Boolean(this.settings.protectManualChanges))
        .onSet((value) => {
          this.persistSettings({ protectManualChanges: Boolean(value) });
          this.refreshProtectionCharacteristics();
        });

      const testService = this.getOrAddService(accessory, this.Service.Switch, 'Test', 'zone-test');
      testService.getCharacteristic(this.Characteristic.On)
        .onGet(() => false)
        .onSet(async (value) => {
          if (!value) return;
          try {
            await this.handleZoneMotionPulse(zone.id, `${zone.name}/Test`, {
              bypassNightOnly: true,
              manualTest: true,
            });
          } finally {
            setTimeout(() => testService.updateCharacteristic(this.Characteristic.On, false), 600);
          }
        });

      const restoreService = this.getOrAddService(accessory, this.Service.Switch, 'Restore Now', 'zone-restore-now');
      restoreService.getCharacteristic(this.Characteristic.On)
        .onGet(() => false)
        .onSet(async (value) => {
          if (!value) return;
          try {
            await this.restoreZoneNow(zone.id, 'manual restore from Apple Home');
          } finally {
            setTimeout(() => restoreService.updateCharacteristic(this.Characteristic.On, false), 600);
          }
        });
    } else {
      this.removeServiceBySubtype(accessory, this.Service.Switch, 'zone-protect-manual');
      this.removeServiceBySubtype(accessory, this.Service.Switch, 'zone-test');
      this.removeServiceBySubtype(accessory, this.Service.Switch, 'zone-restore-now');
    }

    // Remove pre-v0.7.1 per-zone service labels no longer used by the chosen profile.
    this.api.updatePlatformAccessories([accessory]);
  }

  removeServiceBySubtype(accessory, ServiceType, subtype) {
    const service = accessory.getServiceById(ServiceType, subtype);
    if (!service) return;
    try {
      accessory.removeService(service);
    } catch (error) {
      if (this.config.debug) this.log.warn(`Could not remove HomeKit service ${subtype}: ${error.message}`);
    }
  }

  refreshProtectionCharacteristics() {
    for (const accessory of this.zoneAccessories.values()) {
      const service = accessory.getServiceById(this.Service.Switch, 'zone-protect-manual');
      if (service) service.updateCharacteristic(this.Characteristic.On, Boolean(this.settings.protectManualChanges));
    }
  }

  applyServiceName(service, name) {
    service.displayName = name;

    try {
      service.updateCharacteristic(this.Characteristic.Name, name);
    } catch (error) {
      if (this.config.debug) this.log.warn(`Could not update service Name for ${name}: ${error.message}`);
    }

    if (this.Characteristic.ConfiguredName) {
      try {
        service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
        service.updateCharacteristic(this.Characteristic.ConfiguredName, name);
      } catch (error) {
        if (this.config.debug) this.log.warn(`Could not update ConfiguredName for ${name}: ${error.message}`);
      }
    }

    return service;
  }

  getOrAddService(accessory, ServiceType, name, subtype) {
    const service = accessory.getServiceById(ServiceType, subtype)
      || accessory.addService(ServiceType, name, subtype);
    return this.applyServiceName(service, name);
  }

  updateZoneActivity(zoneId, active) {
    const accessory = this.zoneAccessories.get(zoneId);
    if (!accessory) return;
    const service = accessory.getServiceById(this.Service.MotionSensor, 'zone-active');
    if (!service) return;
    service.updateCharacteristic(this.Characteristic.MotionDetected, Boolean(active));
  }

  setBridgeHealth(online, details = {}) {
    const now = Date.now();
    this.bridgeHealth.online = Boolean(online);
    if (online) {
      this.bridgeHealth.lastSuccessAt = now;
      this.bridgeHealth.lastError = '';
      if (Number.isFinite(details.lightCount)) this.bridgeHealth.lightCount = Number(details.lightCount);
    } else {
      this.bridgeHealth.lastFailureAt = now;
      this.bridgeHealth.lastError = String(details.error || 'Hue Bridge unavailable').slice(0, 300);
    }
  }

  async getHueLights() {
    try {
      const lights = await this.hue.getLights();
      this.setBridgeHealth(true, { lightCount: Object.keys(lights).length });
      return lights;
    } catch (error) {
      this.setBridgeHealth(false, { error: error.message });
      throw error;
    }
  }

  async getHueLightsFast() {
    try {
      const result = await this.hue.getLightsFast({ requireLive: true });
      const lights = result.lights || {};
      this.setBridgeHealth(true, { lightCount: Object.keys(lights).length });
      return result;
    } catch (error) {
      this.setBridgeHealth(false, { error: error.message });
      throw error;
    }
  }

  handleDelayPresetWrite(seconds, value) {
    if (value) {
      this.persistSettings({ delaySeconds: seconds });
      this.refreshDelayCharacteristics();
      this.rescheduleInheritedDelayZones();
      return;
    }

    if (this.settings.delaySeconds === seconds) {
      setTimeout(() => this.refreshDelayCharacteristics(), 150);
    }
  }

  refreshDelayCharacteristics() {
    if (!this.settingsAccessory) return;
    for (const preset of DELAY_PRESETS) {
      const service = this.settingsAccessory.getServiceById(this.Service.Switch, preset.subtype);
      if (service) {
        service.updateCharacteristic(
          this.Characteristic.On,
          this.settings.delaySeconds === preset.seconds,
        );
      }
    }
  }

  async handleSecurityModeWrite(mode, value) {
    if (value) {
      this.persistSettings({ securityMode: mode });
      this.refreshSecurityModeCharacteristics();
      if (mode === 'party') {
        await this.restoreAllActive('Security Party mode enabled');
      }
      return;
    }

    if (this.settings.securityMode === mode) {
      setTimeout(() => this.refreshSecurityModeCharacteristics(), 150);
    }
  }

  refreshSecurityModeCharacteristics() {
    if (!this.settingsAccessory) return;
    for (const mode of SECURITY_MODES) {
      const service = this.settingsAccessory.getServiceById(this.Service.Switch, mode.subtype);
      if (service) {
        service.updateCharacteristic(this.Characteristic.On, this.settings.securityMode === mode.value);
      }
    }
  }

  isPaused(zoneId = this.primaryZoneId) {
    return this.isZonePaused(zoneId);
  }

  isZonePaused(zoneId) {
    return Number(this.zoneControls(zoneId).pausedUntil || 0) > Date.now();
  }

  async handleZonePauseWrite(zoneId, value) {
    const zone = this.zoneMap.get(zoneId);
    if (!zone) return;

    if (value) {
      const pausedUntil = Date.now() + (this.pauseDurationMinutes() * 60 * 1000);
      this.persistZoneControls(zoneId, { pausedUntil });
      this.armZonePauseTimer(zoneId);
      this.refreshZonePauseCharacteristic(zoneId);
      await this.restoreZoneNow(zoneId, `temporary ${this.pauseDurationMinutes()} minute pause enabled`);
      return;
    }

    this.persistZoneControls(zoneId, { pausedUntil: 0 });
    this.armZonePauseTimer(zoneId);
    this.refreshZonePauseCharacteristic(zoneId);
  }

  armZonePauseTimer(zoneId) {
    const existing = this.pauseTimers.get(zoneId);
    if (existing) clearTimeout(existing);
    this.pauseTimers.delete(zoneId);

    const pausedUntil = Number(this.zoneControls(zoneId).pausedUntil || 0);
    if (!pausedUntil) return;

    const remaining = pausedUntil - Date.now();
    if (remaining <= 0) {
      this.persistZoneControls(zoneId, { pausedUntil: 0 });
      this.refreshZonePauseCharacteristic(zoneId);
      return;
    }

    const timer = setTimeout(() => {
      this.pauseTimers.delete(zoneId);
      this.persistZoneControls(zoneId, { pausedUntil: 0 });
      this.refreshZonePauseCharacteristic(zoneId);
      const zone = this.zoneMap.get(zoneId);
      this.log.info(`Temporary motion-lighting pause expired for zone "${zone?.name || zoneId}"; automatic triggers resumed.`);
    }, remaining);
    this.pauseTimers.set(zoneId, timer);
  }

  armAllPauseTimers() {
    for (const zone of this.zones) this.armZonePauseTimer(zone.id);
  }

  clearAllPauseTimers() {
    for (const timer of this.pauseTimers.values()) clearTimeout(timer);
    this.pauseTimers.clear();
  }

  refreshZonePauseCharacteristic(zoneId) {
    const accessory = this.zoneAccessories.get(zoneId);
    if (!accessory) return;
    const service = accessory.getServiceById(this.Service.Switch, 'zone-pause');
    if (service) service.updateCharacteristic(this.Characteristic.On, this.isZonePaused(zoneId));
  }

  logRuntimeDiagnostics() {
    const now = new Date();
    let timezone = 'system-local';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
    } catch (error) {
      if (this.config.debug) this.log.warn(`Could not determine server timezone: ${error.message}`);
    }

    this.log.info(`Runtime clock: ${now.toString()} · timezone ${timezone}`);

    const latitude = Number(this.config.latitude);
    const longitude = Number(this.config.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      if (this.zones.some((zone) => this.zoneEffectiveSettings(zone).nightOnly)) {
        this.log.warn('Night Only is enabled for at least one zone, but latitude/longitude are not configured. Those triggers will fail closed.');
      }
      return;
    }

    const times = getSunTimes(now, latitude, longitude);
    if (!times) {
      this.log.warn(`Could not calculate sunrise/sunset for configured coordinates ${latitude}, ${longitude}.`);
      return;
    }

    this.log.info(`Sun schedule for ${latitude.toFixed(4)}, ${longitude.toFixed(4)}: sunrise ${times.sunrise.toString()} · sunset ${times.sunset.toString()} · Night Only currently ${isNight(now, latitude, longitude) ? 'ACTIVE' : 'inactive'}.`);
  }

  async logHueZoneInventory() {
    try {
      const allLights = await this.getHueLights();
      const ownership = new Map();

      for (const zone of this.zones) {
        if (!zone.lights.length) {
          this.log.info(`Zone "${zone.name}" is ${this.zoneControls(zone).enabled ? 'enabled' : 'disabled'} and staged with no Hue lights yet.`);
          continue;
        }

        const selected = this.hue.resolveConfiguredLights(allLights, zone.lights);
        if (!selected.length) {
          const runtimeEnabled = this.zoneControls(zone).enabled;
          const level = runtimeEnabled ? 'warn' : 'info';
          this.log[level](`Zone "${zone.name}" did not resolve any Hue lights${runtimeEnabled ? '' : ' (zone disabled)'}.`);
          continue;
        }

        this.log.info(`Zone "${zone.name}" is ${this.zoneControls(zone).enabled ? 'enabled' : 'disabled'} and controls ${selected.length} Hue light(s): ${selected.map(({ id, light }) => `${light.serviceName || light.name} [${id}]`).join(', ')}`);
        for (const { id, light } of selected) {
          if (ownership.has(id)) {
            this.log.warn(`Hue light ${light.name} [${id}] appears in both "${ownership.get(id)}" and "${zone.name}". If those zones overlap in time, the later zone safely skips that shared light.`);
          } else {
            ownership.set(id, zone.name);
          }
        }
      }
    } catch (error) {
      this.log.error(`Could not contact Hue Bridge: ${error.message}`);
    }
  }

  zoneEffectiveSettings(zone) {
    const controls = this.zoneControls(zone);
    return effectiveZoneSettings(
      { ...zone, nightOnly: controls.nightOnly },
      this.settings,
      this.settings.securityMode,
    );
  }

  isNightAllowedFor(zone) {
    const effective = this.zoneEffectiveSettings(zone);
    if (!effective.nightOnly) return true;

    const latitude = Number(this.config.latitude);
    const longitude = Number(this.config.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      this.log.error(`Zone "${zone.name}" requires Night Only, but latitude/longitude are not configured. Trigger blocked (fail closed).`);
      return false;
    }

    const result = isNight(new Date(), latitude, longitude);
    if (result === null) {
      this.log.error(`Could not calculate sunrise/sunset for zone "${zone.name}". Trigger blocked (fail closed).`);
      return false;
    }
    return result;
  }

  createEmptyRuntime(zoneId) {
    return {
      zoneId,
      snapshot: null,
      expectedStates: new Map(),
      overrideStartedAt: null,
      restoreAt: null,
      hardStopAt: null,
      timer: null,
      motionInProgress: false,
      restoreInProgress: false,
      restoreRequestedReason: null,
      pendingPulse: null,
    };
  }

  getOrCreateRuntime(zoneId) {
    let runtime = this.zoneRuntimes.get(zoneId);
    if (!runtime) {
      runtime = this.createEmptyRuntime(zoneId);
      this.zoneRuntimes.set(zoneId, runtime);
    }
    return runtime;
  }

  getActiveLightIds(exceptZoneId) {
    const ids = new Set();
    for (const [zoneId, runtime] of this.zoneRuntimes.entries()) {
      if (zoneId === exceptZoneId || !runtime.snapshot) continue;
      for (const id of runtime.snapshot.keys()) ids.add(id);
    }
    return ids;
  }

  async handleZoneMotionPulse(zoneId, source, options = {}) {
    const perfStarted = process.hrtime.bigint();
    const zone = this.zoneMap.get(zoneId);
    if (!zone) {
      this.log.warn(`Motion pulse ignored because zone "${zoneId}" is not configured.`);
      return;
    }

    const bypassNightOnly = Boolean(options.bypassNightOnly);
    const manualTest = Boolean(options.manualTest);
    const runtime = this.getOrCreateRuntime(zoneId);

    if (!this.zoneControls(zone).enabled) {
      if (this.config.debug) this.log.info(`Ignored ${source} pulse because zone "${zone.name}" is disabled.`);
      return;
    }

    if (!zone.lights.length) {
      if (this.config.debug) this.log.info(`Ignored ${source} pulse because zone "${zone.name}" is staged but has no Hue lights yet.`);
      return;
    }

    if (runtime.restoreInProgress || runtime.motionInProgress) {
      runtime.pendingPulse = { source, options: { bypassNightOnly, manualTest } };
      if (this.config.debug) this.log.info(`Queued ${source} pulse for zone "${zone.name}" until current work completes.`);
      return;
    }

    if (!manualTest && this.isZonePaused(zone.id)) {
      if (this.config.debug) this.log.info(`Ignored ${source} pulse because zone "${zone.name}" is temporarily paused.`);
      return;
    }

    if (!manualTest && this.settings.securityMode === 'party') {
      if (this.config.debug) this.log.info(`Ignored ${source} pulse because Security Party mode is active.`);
      return;
    }

    if (!manualTest && !bypassNightOnly && !this.isNightAllowedFor(zone)) {
      if (this.config.debug) this.log.info(`Ignored ${source} pulse because Night Only is active for zone "${zone.name}" and it is currently daytime.`);
      return;
    }

    if (runtime.snapshot) {
      this.log.info(`Motion pulse (${source}) — extending zone "${zone.name}" restore timer.`);
      this.scheduleZoneRestore(zoneId);
      return;
    }

    runtime.motionInProgress = true;
    try {
      const snapshotReadStarted = process.hrtime.bigint();
      const fastLights = await this.getHueLightsFast();
      const snapshotReadMs = Number(process.hrtime.bigint() - snapshotReadStarted) / 1e6;
      const allLights = fastLights.lights;
      let selected = this.hue.resolveConfiguredLights(allLights, zone.lights);
      if (!selected.length) {
        this.log.warn(`Motion pulse received for zone "${zone.name}", but no configured Hue lights could be resolved.`);
        return;
      }

      const activeElsewhere = this.getActiveLightIds(zoneId);
      const skipped = selected.filter(({ id }) => activeElsewhere.has(id));
      if (skipped.length) {
        this.log.warn(`Zone "${zone.name}" skipped ${skipped.length} shared light(s) already controlled by another active zone: ${skipped.map(({ light }) => light.name).join(', ')}`);
        selected = selected.filter(({ id }) => !activeElsewhere.has(id));
      }
      if (!selected.length) {
        this.log.warn(`Zone "${zone.name}" has no available lights after overlap protection; pulse ignored.`);
        return;
      }

      const effective = this.zoneEffectiveSettings(zone);
      runtime.snapshot = new Map();
      runtime.expectedStates = new Map();
      runtime.overrideStartedAt = Date.now();
      const maxSeconds = Math.max(60, Number(zone.maxOverrideSeconds || this.config.maxOverrideSeconds || 600));
      runtime.hardStopAt = runtime.overrideStartedAt + (maxSeconds * 1000);
      runtime.restoreAt = Math.min(
        Date.now() + (Math.max(5, effective.delaySeconds) * 1000),
        runtime.hardStopAt,
      );

      for (const { id, light } of selected) {
        runtime.snapshot.set(id, {
          name: light.name,
          state: copySnapshotState(light),
        });
        const lightEffective = effectiveLightSettings(
          zone,
          this.settings,
          this.settings.securityMode,
          id,
        );
        runtime.expectedStates.set(
          id,
          buildMotionState(light, lightEffective.brightness, lightEffective.colorTemperature),
        );
      }

      // Persist the original states before changing a light. A reboot at any point
      // after this line can still recover and restore the pre-motion state.
      this.persistActiveOverrides();
      this.updateZoneActivity(zoneId, true);

      this.log.info(`Motion pulse (${source}) — zone "${zone.name}" captured ${runtime.snapshot.size} light state(s). Applying bright white.`);

      const writeStarted = process.hrtime.bigint();
      const writeResults = await Promise.allSettled(selected.map(async ({ id, light }) => {
        const desired = runtime.expectedStates.get(id);
        try {
          await this.hue.setLightState(id, desired);
          return { id, light };
        } catch (error) {
          throw new Error(`${light.name} [${id}]: ${error.message}`);
        }
      }));
      for (const result of writeResults) {
        if (result.status === 'rejected') this.log.error(`Failed to set Hue light to motion state: ${result.reason.message}`);
      }
      const writeMs = Number(process.hrtime.bigint() - writeStarted) / 1e6;
      const totalMs = Number(process.hrtime.bigint() - perfStarted) / 1e6;
      if (this.config.performanceLogging !== false) {
        this.log.info(`Performance — ${source} → zone "${zone.name}": snapshot ${fastLights.source} ${snapshotReadMs.toFixed(1)} ms · Hue writes ${writeMs.toFixed(1)} ms · plugin total ${totalMs.toFixed(1)} ms`);
      }

      this.armRuntimeTimer(runtime, runtime.restoreAt);
    } catch (error) {
      this.log.error(`Motion pulse failed for zone "${zone.name}": ${error.message}`);
      runtime.snapshot = null;
      runtime.expectedStates = new Map();
      runtime.overrideStartedAt = null;
      runtime.restoreAt = null;
      runtime.hardStopAt = null;
      this.persistActiveOverrides();
      this.updateZoneActivity(zoneId, false);
    } finally {
      runtime.motionInProgress = false;

      if (runtime.restoreRequestedReason && runtime.snapshot) {
        const requestedReason = runtime.restoreRequestedReason;
        runtime.restoreRequestedReason = null;
        await this.restoreZoneNow(zoneId, requestedReason);
        return;
      }

      if (runtime.pendingPulse) {
        const pending = runtime.pendingPulse;
        runtime.pendingPulse = null;
        await this.handleZoneMotionPulse(zoneId, pending.source, pending.options);
      }
    }
  }

  scheduleZoneRestore(zoneId) {
    const runtime = this.zoneRuntimes.get(zoneId);
    if (!runtime?.snapshot) return;

    const zone = this.zoneMap.get(zoneId);
    const effective = zone
      ? this.zoneEffectiveSettings(zone)
      : { delaySeconds: Number(this.settings.delaySeconds || 90) };
    const delayMs = Math.max(5, Number(effective.delaySeconds || 90)) * 1000;
    const hardStop = Number(runtime.hardStopAt) || (Date.now() + (Math.max(60, Number(this.config.maxOverrideSeconds || 600)) * 1000));
    runtime.hardStopAt = hardStop;
    runtime.restoreAt = Math.min(Date.now() + delayMs, hardStop);
    this.persistActiveOverrides();
    this.armRuntimeTimer(runtime, runtime.restoreAt);
  }

  armRuntimeTimer(runtime, deadline) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
    const delay = Math.max(0, Number(deadline) - Date.now());
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      this.restoreZoneNow(runtime.zoneId, 'restore delay elapsed').catch((error) => {
        this.log.error(`Restore failed for zone "${runtime.zoneId}": ${error.message}`);
      });
    }, delay);
  }

  scheduleRecoveryRetry(runtime, reason) {
    runtime.restoreAt = Date.now() + 60000;
    this.persistActiveOverrides();
    this.log.warn(`${reason} Restore will retry in 60 seconds.`);
    this.armRuntimeTimer(runtime, runtime.restoreAt);
  }

  rescheduleInheritedDelayZones() {
    for (const [zoneId, runtime] of this.zoneRuntimes.entries()) {
      if (!runtime.snapshot) continue;
      const zone = this.zoneMap.get(zoneId);
      if (zone && zone.delaySeconds === undefined) this.scheduleZoneRestore(zoneId);
    }
  }

  clearRuntimeTimer(runtime) {
    if (runtime?.timer) clearTimeout(runtime.timer);
    if (runtime) runtime.timer = null;
  }

  clearAllRuntimeTimers() {
    for (const runtime of this.zoneRuntimes.values()) this.clearRuntimeTimer(runtime);
  }

  persistActiveOverrides() {
    if (!this.settingsAccessory) return;
    const active = {};
    for (const [zoneId, runtime] of this.zoneRuntimes.entries()) {
      const persisted = runtimeToPersisted(runtime);
      if (persisted) active[zoneId] = persisted;
    }
    this.settingsAccessory.context.activeOverrides = active;
    this.api.updatePlatformAccessories([this.settingsAccessory]);
  }

  async recoverPersistedOverrides() {
    const persisted = this.settingsAccessory?.context?.activeOverrides || {};
    const recovered = [];

    for (const [zoneId, data] of Object.entries(persisted)) {
      const runtime = persistedToRuntime(zoneId, data);
      if (!runtime) continue;
      this.zoneRuntimes.set(zoneId, runtime);
      this.updateZoneActivity(zoneId, true);
      recovered.push(runtime);
    }

    if (!recovered.length) return;
    this.log.warn(`Recovered ${recovered.length} active motion-lighting override(s) from persistent state after startup.`);

    const partyMode = this.settings.securityMode === 'party';
    for (const runtime of recovered) {
      const recoveredZone = this.zoneMap.get(runtime.zoneId);
      const forceRestore = partyMode
        || !recoveredZone
        || !this.zoneControls(recoveredZone).enabled
        || this.isZonePaused(runtime.zoneId);
      const deadline = Math.min(
        Number(runtime.restoreAt) || Date.now(),
        Number(runtime.hardStopAt) || Date.now(),
      );
      if (forceRestore || deadline <= Date.now()) {
        await this.restoreZoneNow(runtime.zoneId, 'startup recovery');
      } else {
        this.armRuntimeTimer(runtime, deadline);
        this.log.info(`Re-armed recovered zone "${runtime.zoneId}" to restore in ${Math.ceil((deadline - Date.now()) / 1000)} second(s).`);
      }
    }
  }

  async restoreAllActive(reason) {
    const zoneIds = Array.from(this.zoneRuntimes.keys());
    for (const zoneId of zoneIds) {
      await this.restoreZoneNow(zoneId, reason);
    }
  }

  async restoreZoneNow(zoneId, reason) {
    const runtime = this.zoneRuntimes.get(zoneId);
    if (!runtime) return;

    if (runtime.motionInProgress) {
      runtime.restoreRequestedReason = reason;
      return;
    }
    if (runtime.restoreInProgress || !runtime.snapshot) return;

    runtime.restoreInProgress = true;
    this.clearRuntimeTimer(runtime);
    let completed = false;

    try {
      const protect = this.settings.protectManualChanges;
      let currentLights = null;

      if (protect) {
        try {
          currentLights = (await this.getHueLightsFast()).lights;
        } catch (error) {
          this.log.error(`Could not verify manual changes before restoring zone "${zoneId}". Protect Manual Changes is enabled, so restore is being deferred (fail closed): ${error.message}`);
          this.scheduleRecoveryRetry(runtime, `Zone "${zoneId}" could not be securely verified.`);
          return;
        }
      }

      this.log.info(`Restoring previous Hue state for zone "${zoneId}" (${reason}).`);
      const restoreJobs = [];

      for (const [id, saved] of runtime.snapshot.entries()) {
        if (protect) {
          const current = currentLights?.[id];
          const expected = runtime.expectedStates.get(id);
          if (!current || !stateLooksLikeMotion(current.state, expected)) {
            this.log.info(`Leaving ${saved.name} [${id}] alone because it changed while motion lighting was active or its state could not be verified.`);
            continue;
          }
        }

        restoreJobs.push((async () => {
          await this.hue.setLightState(id, sanitizeRestoreState(saved.state));
          return { id, saved };
        })());
      }

      const restoreResults = await Promise.allSettled(restoreJobs);
      let failures = 0;
      for (const result of restoreResults) {
        if (result.status === 'rejected') {
          failures += 1;
          this.log.error(`Failed to restore Hue light: ${result.reason.message}`);
        }
      }

      if (failures) {
        this.scheduleRecoveryRetry(runtime, `Zone "${zoneId}" had ${failures} restore failure(s).`);
        return;
      }

      runtime.snapshot = null;
      runtime.expectedStates = new Map();
      runtime.overrideStartedAt = null;
      runtime.restoreAt = null;
      runtime.hardStopAt = null;
      completed = true;
      this.persistActiveOverrides();
    } finally {
      runtime.restoreInProgress = false;
      const pending = runtime.pendingPulse;
      runtime.pendingPulse = null;

      if (completed) {
        this.zoneRuntimes.delete(zoneId);
        this.persistActiveOverrides();
        this.updateZoneActivity(zoneId, false);
      }

      if (pending) {
        await this.handleZoneMotionPulse(zoneId, pending.source, pending.options);
      }
    }
  }
}
