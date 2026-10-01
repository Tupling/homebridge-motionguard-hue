'use strict';

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeLightSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [id, value] of Object.entries(raw)) {
    const key = String(id || '').trim();
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const next = {};
    if (Number.isFinite(Number(value.brightness))) {
      next.brightness = clampNumber(value.brightness, 100, 1, 100);
    }
    if (Number.isFinite(Number(value.colorTemperature))) {
      next.colorTemperature = Math.round(clampNumber(value.colorTemperature, 200, 153, 500));
    }
    if (Object.keys(next).length) result[key] = next;
  }
  return result;
}

function normalizeZoneId(value, index = 0) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || `zone-${index + 1}`;
}

/**
 * Normalize zone configuration while preserving HomeKit accessory identity.
 *
 * v0.4+ configs set zoneManagerVersion >= 1 and may explicitly mark one zone
 * with legacyTrigger=true. Older v0.3 configs did not have that marker; their
 * primary zone used the original fixed Ring Motion Pulse UUID. During upgrade
 * we infer legacyTrigger for that old primary zone so existing automations do
 * not detach.
 */
function normalizeZones(config = {}) {
  const rawZones = Array.isArray(config.zones)
    ? config.zones.filter((zone) => zone && typeof zone === 'object')
    : [];

  if (!rawZones.length) {
    const lights = Array.isArray(config.lights)
      ? config.lights.map((item) => String(item).trim()).filter(Boolean)
      : [];

    if (!lights.length) return [];

    return [{
      id: 'default',
      name: 'Default',
      lights,
      enabled: true,
      primary: true,
      legacy: true,
      legacyTrigger: true,
    }];
  }

  const seen = new Set();
  const zones = rawZones.map((raw, index) => {
    const name = String(raw.name || `Zone ${index + 1}`).trim() || `Zone ${index + 1}`;
    const id = normalizeZoneId(raw.id || name, index);
    if (seen.has(id)) {
      throw new Error(`Duplicate MotionGuard zone id: ${id}`);
    }
    seen.add(id);

    const lights = Array.isArray(raw.lights)
      ? raw.lights.map((item) => String(item).trim()).filter(Boolean)
      : [];

    const zone = {
      id,
      name,
      lights,
      lightSettings: normalizeLightSettings(raw.lightSettings),
      enabled: raw.enabled !== false,
      primary: Boolean(raw.primary),
      legacy: false,
      legacyTrigger: Boolean(raw.legacyTrigger),
    };

    if (Number.isFinite(Number(raw.brightness))) {
      zone.brightness = clampNumber(raw.brightness, 100, 1, 100);
    }
    if (Number.isFinite(Number(raw.colorTemperature))) {
      zone.colorTemperature = Math.round(clampNumber(raw.colorTemperature, 200, 153, 500));
    }
    if (Number.isFinite(Number(raw.delaySeconds))) {
      zone.delaySeconds = Math.round(clampNumber(raw.delaySeconds, 90, 5, 3600));
    }
    if (Number.isFinite(Number(raw.maxOverrideSeconds))) {
      zone.maxOverrideSeconds = Math.round(clampNumber(raw.maxOverrideSeconds, 600, 60, 7200));
    }
    if (typeof raw.nightOnly === 'boolean') {
      zone.nightOnly = raw.nightOnly;
    }

    return zone;
  });

  const explicitlyPrimary = zones.findIndex((zone) => zone.primary);
  const primaryIndex = explicitlyPrimary >= 0 ? explicitlyPrimary : 0;
  for (let i = 0; i < zones.length; i += 1) {
    zones[i].primary = i === primaryIndex;
  }

  // v0.3 used the fixed Ring Motion Pulse UUID for the primary zone. Infer that
  // relationship once for old configs, then the v0.4 UI persists legacyTrigger.
  if (Number(config.zoneManagerVersion || 0) < 1 && !zones.some((zone) => zone.legacyTrigger)) {
    zones[primaryIndex].legacyTrigger = true;
  }

  const legacyTriggerZones = zones.filter((zone) => zone.legacyTrigger);
  if (legacyTriggerZones.length > 1) {
    throw new Error('Only one zone may preserve the legacy Ring Motion Pulse accessory identity.');
  }

  return zones;
}

function effectiveZoneSettings(zone, globalSettings = {}, securityMode = 'normal') {
  const mode = ['normal', 'night', 'away', 'party'].includes(securityMode)
    ? securityMode
    : 'normal';

  const settings = {
    brightness: clampNumber(
      zone?.brightness,
      clampNumber(globalSettings.brightness, 100, 1, 100),
      1,
      100,
    ),
    colorTemperature: Math.round(clampNumber(
      zone?.colorTemperature,
      clampNumber(globalSettings.colorTemperature, 200, 153, 500),
      153,
      500,
    )),
    delaySeconds: Math.round(clampNumber(
      zone?.delaySeconds,
      clampNumber(globalSettings.delaySeconds, 90, 5, 3600),
      5,
      3600,
    )),
    nightOnly: typeof zone?.nightOnly === 'boolean'
      ? zone.nightOnly
      : Boolean(globalSettings.nightOnly),
  };

  if (mode === 'night' || mode === 'away') {
    settings.nightOnly = false;
  }
  if (mode === 'away') {
    settings.brightness = 100;
  }

  return settings;
}

function effectiveLightSettings(zone, globalSettings = {}, securityMode = 'normal', lightId = '') {
  const base = effectiveZoneSettings(zone, globalSettings, securityMode);
  const override = zone?.lightSettings && typeof zone.lightSettings === 'object'
    ? zone.lightSettings[String(lightId)]
    : null;

  if (!override || typeof override !== 'object') return base;

  const result = { ...base };
  // Away mode intentionally remains an emergency-style 100% brightness mode.
  // Per-service brightness customization applies in the other modes only.
  if (securityMode !== 'away' && Number.isFinite(Number(override.brightness))) {
    result.brightness = clampNumber(override.brightness, base.brightness, 1, 100);
  }
  if (Number.isFinite(Number(override.colorTemperature))) {
    result.colorTemperature = Math.round(clampNumber(override.colorTemperature, base.colorTemperature, 153, 500));
  }
  return result;
}

function runtimeToPersisted(runtime) {
  if (!runtime?.snapshot || !(runtime.snapshot instanceof Map) || runtime.snapshot.size === 0) {
    return null;
  }

  return {
    snapshot: Array.from(runtime.snapshot.entries()),
    expectedStates: Array.from((runtime.expectedStates || new Map()).entries()),
    overrideStartedAt: Number(runtime.overrideStartedAt) || Date.now(),
    restoreAt: Number(runtime.restoreAt) || Date.now(),
    hardStopAt: Number(runtime.hardStopAt) || Date.now(),
  };
}

function persistedToRuntime(zoneId, persisted) {
  if (!persisted || !Array.isArray(persisted.snapshot) || persisted.snapshot.length === 0) {
    return null;
  }

  const snapshot = new Map();
  for (const entry of persisted.snapshot) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, saved] = entry;
    if (!id || !saved || typeof saved !== 'object' || !saved.state) continue;
    snapshot.set(String(id), saved);
  }
  if (!snapshot.size) return null;

  const expectedStates = new Map();
  if (Array.isArray(persisted.expectedStates)) {
    for (const entry of persisted.expectedStates) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[0] || !entry[1]) continue;
      expectedStates.set(String(entry[0]), entry[1]);
    }
  }

  return {
    zoneId: String(zoneId),
    snapshot,
    expectedStates,
    overrideStartedAt: Number(persisted.overrideStartedAt) || Date.now(),
    restoreAt: Number(persisted.restoreAt) || Date.now(),
    hardStopAt: Number(persisted.hardStopAt) || Date.now(),
    timer: null,
    motionInProgress: false,
    restoreInProgress: false,
    restoreRequestedReason: null,
    pendingPulse: null,
  };
}

module.exports = {
  effectiveLightSettings,
  effectiveZoneSettings,
  normalizeLightSettings,
  normalizeZoneId,
  normalizeZones,
  persistedToRuntime,
  runtimeToPersisted,
};
