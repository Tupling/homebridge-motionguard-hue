'use strict';

const PLUGIN_NAME = 'homebridge-hue-motion-restore';
const PLATFORM_NAME = 'HueMotionRestore';
const PULSE_RESET_MS = 600;
const DELAY_CHOICES = [30, 60, 90, 120, 300];

function delayLabel(seconds) {
  if (seconds === 120) return 'Restore 2 Minutes';
  if (seconds === 300) return 'Restore 5 Minutes';
  return `Restore ${seconds} Seconds`;
}

class HomeKitControls {
  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.uuid = this.api.hap.uuid;
    this.zoneAccessories = new Map();
  }

  reconcile(zones) {
    const desired = new Set();
    for (const zone of zones) {
      const pulseAccessory = this.getOrCreatePulseAccessory(zone);
      const controlsAccessory = this.getOrCreateControlsAccessory(zone);
      desired.add(pulseAccessory.UUID);
      desired.add(controlsAccessory.UUID);
      this.zoneAccessories.set(zone.id, { pulseAccessory, controlsAccessory });
      this.configurePulse(pulseAccessory, zone);
      this.configureControls(controlsAccessory, zone);
      this.removeLegacyCompanions(zone, desired);
    }

    const stale = this.platform.cachedAccessories.filter((accessory) => {
      return accessory.context?.motionGuardManaged === true && !desired.has(accessory.UUID);
    });
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.platform.cachedAccessories = this.platform.cachedAccessories.filter((item) => !stale.includes(item));
    }
  }

  getOrCreatePulseAccessory(zone) {
    const name = zone.legacyTrigger ? 'Ring Motion Pulse' : `${zone.name} Motion Pulse`;
    let accessory = this.platform.cachedAccessories.find((candidate) => {
      if (candidate.context?.motionGuardRole === 'pulse' && candidate.context?.zoneId === zone.id) return true;
      if (zone.legacyTrigger && candidate.displayName === 'Ring Motion Pulse') return true;
      return candidate.displayName === name;
    });

    if (!accessory) {
      const id = zone.legacyTrigger
        ? 'HueMotionRestore:Ring Motion Pulse'
        : `HueMotionRestore:zone:${zone.id}:pulse`;
      accessory = new this.api.platformAccessory(name, this.uuid.generate(id));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.cachedAccessories.push(accessory);
    }

    accessory.displayName = name;
    accessory.context.motionGuardManaged = true;
    accessory.context.motionGuardRole = 'pulse';
    accessory.context.zoneId = zone.id;
    accessory.context.zoneName = zone.name;
    this.api.updatePlatformAccessories([accessory]);
    return accessory;
  }

  getOrCreateControlsAccessory(zone) {
    const name = zone.legacyTrigger ? 'Hue Motion Restore' : `${zone.name} MotionGuard`;
    let accessory = this.platform.cachedAccessories.find((candidate) => {
      if (candidate.context?.motionGuardRole === 'controls' && candidate.context?.zoneId === zone.id) return true;
      if (zone.legacyTrigger && candidate.displayName === 'Hue Motion Restore') return true;
      return candidate.displayName === name;
    });

    if (!accessory) {
      const id = zone.legacyTrigger
        ? 'HueMotionRestore:Hue Motion Restore'
        : `HueMotionRestore:zone:${zone.id}:controls`;
      accessory = new this.api.platformAccessory(name, this.uuid.generate(id));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.cachedAccessories.push(accessory);
    }

    accessory.displayName = name;
    accessory.context.motionGuardManaged = true;
    accessory.context.motionGuardRole = 'controls';
    accessory.context.zoneId = zone.id;
    accessory.context.zoneName = zone.name;
    this.api.updatePlatformAccessories([accessory]);
    return accessory;
  }

  removeLegacyCompanions(zone, desired) {
    const names = new Set([`Test ${zone.name}`, `${zone.name} Lighting Active`]);
    const obsolete = this.platform.cachedAccessories.filter((accessory) => {
      return !desired.has(accessory.UUID) && names.has(accessory.displayName);
    });
    if (!obsolete.length) return;
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, obsolete);
    this.platform.cachedAccessories = this.platform.cachedAccessories.filter((item) => !obsolete.includes(item));
  }

  accessoryInfo(accessory, model) {
    accessory.getService(this.Service.AccessoryInformation)
      ?.setCharacteristic(this.Characteristic.Manufacturer, 'MotionGuard')
      .setCharacteristic(this.Characteristic.Model, model)
      .setCharacteristic(this.Characteristic.FirmwareRevision, '0.7.0');
  }

  service(accessory, ServiceType, name, subtype) {
    let service = subtype ? accessory.getServiceById(ServiceType, subtype) : accessory.getService(ServiceType);
    if (!service) service = accessory.addService(ServiceType, name, subtype);
    service.setCharacteristic(this.Characteristic.Name, name);
    return service;
  }

  configurePulse(accessory, zone) {
    this.accessoryInfo(accessory, 'Motion Pulse');
    const name = zone.legacyTrigger ? 'Ring Motion Pulse' : `${zone.name} Motion Pulse`;
    const service = this.service(accessory, this.Service.Switch, name);
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet((value) => {
        if (!value) return;
        const received = this.platform.nowMs();
        this.platform.perf(`${name} received`, received, true);
        setTimeout(() => service.getCharacteristic(this.Characteristic.On).updateValue(false), PULSE_RESET_MS).unref?.();
        void this.platform.triggerZone(zone, { source: 'motion', bypassNight: false, received });
      });
  }

  configureControls(accessory, zone) {
    this.accessoryInfo(accessory, 'Motion Lighting Controls');
    const state = this.platform.controlState(zone);

    const motion = this.service(accessory, this.Service.Lightbulb, 'Motion Lighting', 'motion-lighting');
    motion.setPrimaryService?.(true);
    motion.getCharacteristic(this.Characteristic.On)
      .onGet(() => state.enabled)
      .onSet((value) => {
        state.enabled = Boolean(value);
        void this.platform.saveControl(zone.id);
        if (!state.enabled) void this.platform.restoreZone(zone, 'motion-disabled');
      });
    motion.getCharacteristic(this.Characteristic.Brightness)
      .setProps({ minValue: 1, maxValue: 100, minStep: 1 })
      .onGet(() => state.brightness)
      .onSet((value) => {
        state.brightness = Math.max(1, Math.min(100, Number(value)));
        void this.platform.saveControl(zone.id);
      });
    motion.getCharacteristic(this.Characteristic.ColorTemperature)
      .setProps({ minValue: 153, maxValue: 500, minStep: 1 })
      .onGet(() => state.colorTemperature)
      .onSet((value) => {
        state.colorTemperature = Math.max(153, Math.min(500, Math.round(Number(value))));
        void this.platform.saveControl(zone.id);
      });

    this.booleanSwitch(accessory, 'Night Only', 'night-only',
      () => state.nightOnly,
      (value) => {
        state.nightOnly = value;
        void this.platform.saveControl(zone.id);
      });

    this.booleanSwitch(accessory, 'Protect Manual Changes', 'protect-manual',
      () => state.protectManualChanges,
      (value) => {
        state.protectManualChanges = value;
        void this.platform.saveControl(zone.id);
      });

    for (const seconds of DELAY_CHOICES) {
      const restore = this.service(accessory, this.Service.Switch, delayLabel(seconds), `restore-${seconds}`);
      restore.getCharacteristic(this.Characteristic.On)
        .onGet(() => state.delaySeconds === seconds)
        .onSet((value) => {
          if (!value) {
            if (state.delaySeconds === seconds) queueMicrotask(() => restore.getCharacteristic(this.Characteristic.On).updateValue(true));
            return;
          }
          state.delaySeconds = seconds;
          this.refreshDelaySwitches(zone);
          void this.platform.saveControl(zone.id);
          this.platform.rescheduleActiveZone(zone);
        });
    }

    this.momentarySwitch(accessory, 'Test Motion Lighting', 'test-motion', () => {
      void this.platform.triggerZone(zone, { source: 'test', bypassNight: true, received: this.platform.nowMs() });
    });

    this.momentarySwitch(accessory, 'Restore Now', 'restore-now', () => {
      void this.platform.restoreZone(zone, 'manual');
    });

    const active = this.service(accessory, this.Service.OccupancySensor, 'Lighting Active', 'lighting-active');
    active.getCharacteristic(this.Characteristic.OccupancyDetected)
      .onGet(() => this.platform.isZoneActive(zone.id) ? 1 : 0);
  }

  booleanSwitch(accessory, name, subtype, getter, setter) {
    const service = this.service(accessory, this.Service.Switch, name, subtype);
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(getter()))
      .onSet((value) => setter(Boolean(value)));
  }

  momentarySwitch(accessory, name, subtype, action) {
    const service = this.service(accessory, this.Service.Switch, name, subtype);
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet((value) => {
        if (!value) return;
        queueMicrotask(() => service.getCharacteristic(this.Characteristic.On).updateValue(false));
        action();
      });
  }

  refreshDelaySwitches(zone) {
    const accessory = this.zoneAccessories.get(zone.id)?.controlsAccessory;
    if (!accessory) return;
    const selected = this.platform.controlState(zone).delaySeconds;
    for (const seconds of DELAY_CHOICES) {
      accessory.getServiceById(this.Service.Switch, `restore-${seconds}`)
        ?.getCharacteristic(this.Characteristic.On)
        .updateValue(selected === seconds);
    }
  }

  updateActive(zoneId, active) {
    const accessory = this.zoneAccessories.get(zoneId)?.controlsAccessory;
    accessory?.getServiceById(this.Service.OccupancySensor, 'lighting-active')
      ?.getCharacteristic(this.Characteristic.OccupancyDetected)
      .updateValue(active ? 1 : 0);
  }
}

module.exports = { HomeKitControls, DELAY_CHOICES };
