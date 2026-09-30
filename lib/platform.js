'use strict';

const {
  HueClient,
  buildMotionState,
  copySnapshotState,
  sanitizeRestoreState,
  stateLooksLikeMotion,
} = require('./hue-client');
const { HomeKitControls } = require('./homekit-controls');
const { StateStore } = require('./state-store');
const { isNight } = require('./sun');
const {
  effectiveZoneSettings,
  normalizeZones,
  persistedToRuntime,
  runtimeToPersisted,
} = require('./zones');

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneState(state) {
  const copy = state && typeof state === 'object' ? { ...state } : {};
  if (Array.isArray(state?.xy)) copy.xy = [...state.xy];
  return copy;
}

class MotionGuardPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = [];
    this.controls = new Map();
    this.runtimes = new Map();
    this.lightClaims = new Map();
    this.store = new StateStore({ api, log });
    this.homekit = new HomeKitControls(this);
    this.hue = null;

    api.on('didFinishLaunching', () => {
      void this.launch().catch((error) => this.log.error(`MotionGuard startup failed: ${error.message}`));
    });
    api.on('shutdown', () => {
      this.hue?.close();
      for (const runtime of this.runtimes.values()) if (runtime?.timer) clearTimeout(runtime.timer);
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.push(accessory);
  }

  nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  perf(message, started, zeroPoint = false) {
    if (!this.config.performanceLogging) return;
    const delta = zeroPoint ? 0 : Math.max(0, this.nowMs() - started);
    this.log.info(`[Performance] ${message} +${delta.toFixed(1)}ms`);
  }

  async launch() {
    const zones = normalizeZones(this.config).filter((zone) => zone.enabled !== false);
    if (!zones.length) {
      this.log.warn('No enabled MotionGuard zones are configured.');
      return;
    }
    await this.store.load();

    this.hue = new HueClient({
      host: String(this.config.bridgeHost || '').trim(),
      applicationKey: String(this.config.hueApplicationKey || this.config.hueUsername || '').trim(),
      certificateFingerprint: String(this.config.certificateFingerprint || '').trim(),
      bridgeId: String(this.config.bridgeId || '').trim(),
      log: this.log,
    });

    const started = this.nowMs();
    const lights = await this.hue.primeLightCache();
    this.perf(`Hue cache primed with ${Object.keys(lights).length} lights`, started);
    this.hue.startEventStream((changed) => {
      if (this.config.debug) this.log.debug(`Hue event stream updated ${changed.length} light state(s).`);
    });

    this.homekit.reconcile(zones);
    this.restorePersistedRuntimes(zones);
  }

  defaultControlState(zone) {
    const settings = effectiveZoneSettings(zone, {
      brightness: safeNumber(this.config.brightness, 100),
      colorTemperature: safeNumber(this.config.colorTemperature, 200),
      delaySeconds: safeNumber(this.config.delaySeconds, 90),
      nightOnly: Boolean(this.config.nightOnly),
    }, String(this.config.securityMode || 'normal'));

    return {
      enabled: this.config.motionLightingEnabled !== false,
      brightness: settings.brightness,
      colorTemperature: settings.colorTemperature,
      delaySeconds: settings.delaySeconds,
      nightOnly: settings.nightOnly,
      protectManualChanges: typeof zone.protectManualChanges === 'boolean'
        ? zone.protectManualChanges
        : this.config.protectManualChanges !== false,
    };
  }

  controlState(zone) {
    if (this.controls.has(zone.id)) return this.controls.get(zone.id);
    const defaults = this.defaultControlState(zone);
    const saved = this.store.control(zone.id);
    const value = {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
      brightness: Math.max(1, Math.min(100, safeNumber(saved.brightness, defaults.brightness))),
      colorTemperature: Math.max(153, Math.min(500, Math.round(safeNumber(saved.colorTemperature, defaults.colorTemperature)))),
      delaySeconds: Math.max(5, Math.min(3600, Math.round(safeNumber(saved.delaySeconds, defaults.delaySeconds)))),
      nightOnly: typeof saved.nightOnly === 'boolean' ? saved.nightOnly : defaults.nightOnly,
      protectManualChanges: typeof saved.protectManualChanges === 'boolean'
        ? saved.protectManualChanges
        : defaults.protectManualChanges,
    };
    this.controls.set(zone.id, value);
    return value;
  }

  async saveControl(zoneId) {
    await this.store.saveControl(zoneId, this.controls.get(zoneId));
  }

  isZoneActive(zoneId) {
    return Boolean(this.runtimes.get(zoneId)?.snapshot?.size);
  }

  rescheduleActiveZone(zone) {
    const runtime = this.runtimes.get(zone.id);
    if (!runtime?.snapshot?.size) return;
    runtime.restoreAt = Date.now() + (this.controlState(zone).delaySeconds * 1000);
    this.scheduleRestore(zone, runtime);
    void this.persistRuntime(zone.id, runtime);
  }

  async triggerZone(zone, { source = 'motion', bypassNight = false, received = this.nowMs() } = {}) {
    const control = this.controlState(zone);
    if (!control.enabled && source !== 'test') return;

    if (!bypassNight && control.nightOnly) {
      const night = isNight(new Date(), Number(this.config.latitude), Number(this.config.longitude));
      if (night !== true) {
        if (night === null) this.log.warn(`${zone.name}: Night Only enabled but valid coordinates are unavailable; trigger blocked.`);
        return;
      }
    }

    let runtime = this.runtimes.get(zone.id);
    if (runtime?.motionInProgress) {
      runtime.pendingPulse = { source, bypassNight, received };
      return;
    }

    if (runtime?.snapshot?.size) {
      runtime.restoreAt = Date.now() + (control.delaySeconds * 1000);
      this.scheduleRestore(zone, runtime);
      await this.persistRuntime(zone.id, runtime);
      this.perf(`${zone.name}: retriggered; timer extended`, received);
      return;
    }

    runtime = this.newRuntime(zone, control);
    this.runtimes.set(zone.id, runtime);

    try {
      const snapStarted = this.nowMs();
      let inventory = this.hue.getCachedLights();
      let resolved = this.hue.resolveConfiguredLights(inventory, zone.lights);
      if (resolved.length !== zone.lights.length) {
        inventory = await this.hue.getLights();
        resolved = this.hue.resolveConfiguredLights(inventory, zone.lights);
      }
      this.perf(`${zone.name}: snapshot resolved from cache`, snapStarted);
      if (!resolved.length) throw new Error(`No configured Hue lights found for ${zone.name}.`);

      const commands = [];
      for (const { id, light } of resolved) {
        let claim = this.lightClaims.get(id);
        if (!claim) {
          claim = { baseline: { state: copySnapshotState(light) }, owners: new Set(), lastExpectedState: null };
          this.lightClaims.set(id, claim);
        }
        claim.owners.add(zone.id);
        runtime.snapshot.set(id, claim.baseline);

        const expected = buildMotionState(light, control.brightness, control.colorTemperature);
        runtime.expectedStates.set(id, expected);
        claim.lastExpectedState = cloneState(expected);
        commands.push({ id, state: expected });
      }

      await this.persistRuntime(zone.id, runtime);
      this.homekit.updateActive(zone.id, true);
      const outcome = await this.hue.setLightStates(commands);
      this.perf(`${zone.name}: ${commands.length} Hue command(s) acknowledged in ${outcome.durationMs.toFixed(1)}ms`, received);
      for (const failure of outcome.results.filter((item) => item.status === 'rejected')) {
        this.log.warn(`${zone.name}: Hue command failed: ${failure.reason?.message || failure.reason}`);
      }
      this.scheduleRestore(zone, runtime);
    } catch (error) {
      this.log.error(`${zone.name}: motion lighting failed: ${error.message}`);
      runtime.motionInProgress = false;
      await this.restoreZone(zone, 'activation-failed');
      return;
    } finally {
      runtime.motionInProgress = false;
    }

    if (runtime.restoreRequestedReason) {
      const reason = runtime.restoreRequestedReason;
      runtime.restoreRequestedReason = null;
      void this.restoreZone(zone, reason);
    } else if (runtime.pendingPulse) {
      const pending = runtime.pendingPulse;
      runtime.pendingPulse = null;
      void this.triggerZone(zone, pending);
    }
  }

  newRuntime(zone, control) {
    const startedAt = Date.now();
    const maxSeconds = safeNumber(zone.maxOverrideSeconds, safeNumber(this.config.maxOverrideSeconds, 600));
    return {
      zoneId: zone.id,
      snapshot: new Map(),
      expectedStates: new Map(),
      overrideStartedAt: startedAt,
      restoreAt: startedAt + (control.delaySeconds * 1000),
      hardStopAt: startedAt + (maxSeconds * 1000),
      timer: null,
      motionInProgress: true,
      restoreInProgress: false,
      restoreRequestedReason: null,
      pendingPulse: null,
    };
  }

  scheduleRestore(zone, runtime) {
    if (runtime.timer) clearTimeout(runtime.timer);
    const deadline = Math.min(runtime.restoreAt, runtime.hardStopAt);
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void this.restoreZone(zone, deadline === runtime.hardStopAt ? 'maximum-override' : 'timer');
    }, Math.max(0, deadline - Date.now()));
    runtime.timer.unref?.();
  }

  async restoreZone(zone, reason) {
    const runtime = this.runtimes.get(zone.id);
    if (!runtime?.snapshot?.size || runtime.restoreInProgress) return;
    if (runtime.motionInProgress) {
      runtime.restoreRequestedReason = reason;
      return;
    }

    runtime.restoreInProgress = true;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;

    let retryScheduled = false;
    try {
      const control = this.controlState(zone);
      let current = this.hue.getCachedLights();
      if (control.protectManualChanges) {
        try {
          current = await this.hue.getLights();
        } catch (error) {
          this.log.warn(`${zone.name}: current Hue state could not be verified; retrying restore in 5 seconds (${error.message}).`);
          runtime.restoreAt = Date.now() + 5000;
          this.scheduleRestore(zone, runtime);
          await this.persistRuntime(zone.id, runtime);
          retryScheduled = true;
          return;
        }
      }

      const commands = [];
      for (const [id, saved] of runtime.snapshot.entries()) {
        const claim = this.lightClaims.get(id);
        if (claim) claim.owners.delete(zone.id);
        if (claim?.owners?.size) continue;

        const expected = claim?.lastExpectedState || runtime.expectedStates.get(id);
        if (control.protectManualChanges && !stateLooksLikeMotion(current[id]?.state, expected)) {
          this.log.info(`${zone.name}: preserving manual change for ${current[id]?.name || id}.`);
          this.lightClaims.delete(id);
          continue;
        }

        const baseline = claim?.baseline || saved;
        if (baseline?.state) commands.push({ id, state: sanitizeRestoreState(baseline.state) });
        this.lightClaims.delete(id);
      }

      if (commands.length) {
        const outcome = await this.hue.setLightStates(commands);
        for (const failure of outcome.results.filter((item) => item.status === 'rejected')) {
          this.log.warn(`${zone.name}: restore command failed: ${failure.reason?.message || failure.reason}`);
        }
      }
      this.log.info(`${zone.name}: restored previous Hue state (${reason}).`);
    } finally {
      runtime.restoreInProgress = false;
      if (!retryScheduled) {
        this.runtimes.delete(zone.id);
        this.homekit.updateActive(zone.id, false);
        await this.store.saveRuntime(zone.id, null);
      }
    }
  }

  async persistRuntime(zoneId, runtime) {
    await this.store.saveRuntime(zoneId, runtimeToPersisted(runtime));
  }

  restorePersistedRuntimes(zones) {
    for (const zone of zones) {
      const runtime = persistedToRuntime(zone.id, this.store.runtime(zone.id));
      if (!runtime) continue;
      this.runtimes.set(zone.id, runtime);
      for (const [id, baseline] of runtime.snapshot.entries()) {
        let claim = this.lightClaims.get(id);
        if (!claim) {
          claim = { baseline, owners: new Set(), lastExpectedState: runtime.expectedStates.get(id) || null };
          this.lightClaims.set(id, claim);
        }
        claim.owners.add(zone.id);
        if (runtime.expectedStates.get(id)) claim.lastExpectedState = runtime.expectedStates.get(id);
      }
      this.homekit.updateActive(zone.id, true);
      if (Math.min(runtime.restoreAt, runtime.hardStopAt) <= Date.now()) void this.restoreZone(zone, 'restart-recovery');
      else this.scheduleRestore(zone, runtime);
    }
  }
}

module.exports = { MotionGuardPlatform };
