'use strict';

(() => {
  let config = null;
  let syncTimer = null;
  let initialized = false;
  let discoveredLights = [];
  let discoveredFixtures = [];
  let bridgeHealth = {
    state: 'unknown',
    checkedAt: null,
    lightCount: null,
    message: '',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeZoneId() {
    if (globalThis.crypto?.randomUUID) {
      return `zone-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    const random = Math.random().toString(36).slice(2, 10);
    return `zone-${Date.now().toString(36)}-${random}`;
  }

  function legacyDerivedZoneId(value, index = 0) {
    const cleaned = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return cleaned || `zone-${index + 1}`;
  }

  function normalizeLocalConfig(raw) {
    const next = clone(raw || {});
    next.platform = next.platform || 'HueMotionRestore';
    next.name = next.name || 'MotionGuard for Hue';
    if (next.brightness !== undefined) next.brightness = Number(next.brightness);
    if (next.colorTemperature !== undefined) next.colorTemperature = Number(next.colorTemperature);
    if (next.delaySeconds !== undefined) next.delaySeconds = Number(next.delaySeconds);
    if (next.nightOnly !== undefined) next.nightOnly = Boolean(next.nightOnly);
    if (next.protectManualChanges !== undefined) next.protectManualChanges = Boolean(next.protectManualChanges);
    if (next.securityMode !== undefined && !['normal', 'night', 'away', 'party'].includes(next.securityMode)) delete next.securityMode;
    if (next.homekitProfile !== undefined && !['minimal', 'standard', 'advanced'].includes(next.homekitProfile)) delete next.homekitProfile;
    if (next.pauseDurationMinutes !== undefined) next.pauseDurationMinutes = Number(next.pauseDurationMinutes);
    next.maxOverrideSeconds = Number(next.maxOverrideSeconds || 600);
    delete next.directRingEnabled;
    delete next.directRingDebug;
    delete next.ringRefreshToken;
    next.performanceLogging = next.performanceLogging !== false;
    next.debug = Boolean(next.debug);

    if (Array.isArray(next.zones)) {
      const upgradingFromV03 = Number(next.zoneManagerVersion || 0) < 1;
      if (upgradingFromV03 && next.zones.length) {
        let legacyIndex = next.zones.findIndex((zone) => zone?.primary);
        if (legacyIndex < 0) legacyIndex = 0;
        next.zones = next.zones.map((zone, index) => ({
          ...zone,
          legacyTrigger: index === legacyIndex,
        }));
      }
      next.zoneManagerVersion = 2;
      next.zones = next.zones.map((zone, index) => {
        const name = String(zone?.name || `Zone ${index + 1}`);
        return {
          id: String(zone?.id || (upgradingFromV03 ? legacyDerivedZoneId(name, index) : makeZoneId())),
          name,
          enabled: zone?.enabled !== false,
          primary: Boolean(zone?.primary),
          legacyTrigger: Boolean(zone?.legacyTrigger),
          lights: Array.isArray(zone?.lights) ? zone.lights.map(String) : [],
          lightSettings: zone?.lightSettings && typeof zone.lightSettings === 'object' && !Array.isArray(zone.lightSettings) ? clone(zone.lightSettings) : {},
          ...(zone?.brightness !== undefined ? { brightness: Number(zone.brightness) } : {}),
          ...(zone?.colorTemperature !== undefined ? { colorTemperature: Number(zone.colorTemperature) } : {}),
          ...(zone?.delaySeconds !== undefined ? { delaySeconds: Number(zone.delaySeconds) } : {}),
          ...(typeof zone?.nightOnly === 'boolean' ? { nightOnly: zone.nightOnly } : {}),
          ...(zone?.maxOverrideSeconds !== undefined ? { maxOverrideSeconds: Number(zone.maxOverrideSeconds) } : {}),
        };
      });
      ensureSinglePrimary(next.zones);
    }
    return next;
  }

  function ensureSinglePrimary(zones, preferredIndex = null) {
    if (!zones?.length) return;
    let primaryIndex = preferredIndex;
    if (primaryIndex === null || primaryIndex < 0 || primaryIndex >= zones.length) {
      primaryIndex = zones.findIndex((zone) => zone.primary);
      if (primaryIndex < 0) primaryIndex = 0;
    }
    zones.forEach((zone, index) => { zone.primary = index === primaryIndex; });
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncConfig, 180);
  }

  async function syncConfig() {
    try {
      await window.homebridge.updatePluginConfig([config]);
      window.homebridge.enableSaveButton();
    } catch (error) {
      window.homebridge.toast.error(error.message || String(error), 'Could not update configuration');
    }
  }

  function setBasicFields() {
    $$('.config-field').forEach((field) => {
      const key = field.dataset.key;
      const value = config[key];
      if (field.dataset.boolean === 'true') {
        field.checked = value === undefined
          ? field.dataset.defaultBoolean === 'true'
          : Boolean(value);
      } else {
        field.value = value ?? field.dataset.defaultValue ?? '';
      }
    });
  }

  function readBasicField(field) {
    const key = field.dataset.key;
    if (field.dataset.boolean === 'true') {
      config[key] = field.checked;
    } else if (field.dataset.number === 'true') {
      if (field.value === '') delete config[key];
      else config[key] = Number(field.value);
    } else {
      config[key] = field.value;
    }
    scheduleSync();
  }

  function renderLegacyBanner() {
    const hasLegacyLights = Array.isArray(config.lights) && config.lights.filter(Boolean).length > 0;
    const hasZones = Array.isArray(config.zones) && config.zones.length > 0;
    $('#legacyBanner').classList.toggle('d-none', !hasLegacyLights || hasZones);
  }

  function convertLegacyToManaged(name) {
    const legacyLights = Array.isArray(config.lights)
      ? config.lights.filter((item) => String(item).trim())
      : [];
    if (!legacyLights.length) return false;

    config.zoneManagerVersion = 2;
    config.zones = [{
      id: makeZoneId(),
      name: String(name || 'Current Zone').trim() || 'Current Zone',
      enabled: true,
      primary: true,
      legacyTrigger: true,
      lights: legacyLights,
      lightSettings: {},
    }];
    config.lights = [];
    return true;
  }

  function newZone() {
    return {
      id: makeZoneId(),
      name: `Zone ${(config.zones?.length || 0) + 1}`,
      enabled: false,
      primary: !(config.zones?.length),
      legacyTrigger: false,
      lights: [],
      lightSettings: {},
    };
  }

  function zoneNumberInput(label, key, value, min, max, step = 1, placeholder = 'Inherit global') {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <label class="form-label small">${label}</label>
      <input class="form-control form-control-sm" type="number" min="${min}" max="${max}" step="${step}" placeholder="${placeholder}">
    `;
    const input = $('input', wrapper);
    input.value = value ?? '';
    input.addEventListener('input', () => {
      if (input.value === '') delete wrapper.zone[key];
      else wrapper.zone[key] = Number(input.value);
      scheduleSync();
    });
    return wrapper;
  }

  function zoneOptionalBoolean(label, key, zone) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <label class="form-label small">${label}</label>
      <select class="form-select form-select-sm">
        <option value="inherit">Inherit global</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    `;
    const select = $('select', wrapper);
    select.value = typeof zone[key] === 'boolean' ? String(zone[key]) : 'inherit';
    select.addEventListener('change', () => {
      if (select.value === 'inherit') delete zone[key];
      else zone[key] = select.value === 'true';
      scheduleSync();
    });
    return wrapper;
  }

  function bridgePayload() {
    return {
      bridgeHost: String(config.bridgeHost || '').trim(),
      bridgeId: String(config.bridgeId || '').trim(),
      certificateFingerprint: String(config.certificateFingerprint || '').trim(),
      hueApplicationKey: String(config.hueApplicationKey || config.hueUsername || '').trim(),
    };
  }

  function bridgeCredentialsReady() {
    const payload = bridgePayload();
    return Boolean(payload.bridgeHost && payload.bridgeId && payload.certificateFingerprint && payload.hueApplicationKey);
  }

  function formatCheckedAt(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function renderBridgeHealth() {
    const dot = $('#healthDot');
    const title = $('#healthTitle');
    const badge = $('#healthBadge');
    const detail = $('#healthDetail');
    dot.dataset.state = bridgeHealth.state;

    if (bridgeHealth.state === 'online') {
      title.textContent = 'Hue Bridge online';
      badge.className = 'badge text-bg-success';
      badge.textContent = `${bridgeHealth.fixtureCount ?? discoveredFixtures.length ?? 0} fixture(s) · ${bridgeHealth.lightCount ?? discoveredLights.length} service(s)`;
      const multi = Number(bridgeHealth.multiServiceFixtureCount || 0);
      detail.textContent = `Pinned TLS and Hue API v2 authentication succeeded${multi ? ` · ${multi} multi-zone fixture(s) detected` : ''}${bridgeHealth.checkedAt ? ` · checked ${formatCheckedAt(bridgeHealth.checkedAt)}` : ''}.`;
      return;
    }

    if (bridgeHealth.state === 'offline') {
      title.textContent = 'Hue Bridge unavailable';
      badge.className = 'badge text-bg-danger';
      badge.textContent = 'Check failed';
      detail.textContent = `${bridgeHealth.message || 'The bridge could not be reached or verified.'}${discoveredLights.length ? ' The previous discovery list is being retained until a successful refresh.' : ''}`;
      return;
    }

    title.textContent = 'Bridge status unknown';
    badge.className = 'badge text-bg-secondary';
    badge.textContent = 'Not checked';
    detail.textContent = bridgeCredentialsReady()
      ? 'Press Discover / Refresh Lights to verify the bridge and load available Hue lights.'
      : 'Complete the private IP, Bridge ID, pinned TLS fingerprint, and Hue Application Key first.';
  }

  async function discoverHueLights({ quiet = false } = {}) {
    if (!bridgeCredentialsReady()) {
      bridgeHealth = { state: 'unknown', checkedAt: null, lightCount: null, message: '' };
      renderBridgeHealth();
      if (!quiet) window.homebridge.toast.warning('Complete the secure Hue Bridge fields before discovery.', 'MotionGuard for Hue');
      return false;
    }

    const button = $('#discoverLights');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Discovering…';
    try {
      const result = await window.homebridge.request('/discover-lights', bridgePayload());
      discoveredLights = Array.isArray(result?.lights) ? result.lights : [];
      discoveredFixtures = Array.isArray(result?.fixtures) && result.fixtures.length
        ? result.fixtures
        : discoveredLights.map((light) => ({ id: light.ownerId || light.id, name: light.name || light.id, product: {}, multiService: false, lightServiceCount: 1, lightServices: [light] }));
      bridgeHealth = {
        state: 'online',
        checkedAt: result?.checkedAt || new Date().toISOString(),
        lightCount: Number(result?.lightCount ?? discoveredLights.length),
        fixtureCount: Number(result?.fixtureCount ?? discoveredFixtures.length),
        multiServiceFixtureCount: Number(result?.multiServiceFixtureCount ?? discoveredFixtures.filter((fixture) => fixture.multiService).length),
        message: '',
      };
      renderBridgeHealth();
      renderZones();
      if (!quiet) {
        const multi = discoveredFixtures.filter((fixture) => fixture.multiService).length;
        window.homebridge.toast.success(`Discovered ${discoveredFixtures.length} Hue fixture(s), ${discoveredLights.length} controllable light service(s)${multi ? `, including ${multi} multi-zone fixture(s)` : ''}.`, 'MotionGuard for Hue');
      }
      return true;
    } catch (error) {
      bridgeHealth = {
        state: 'offline',
        checkedAt: new Date().toISOString(),
        lightCount: null,
        message: error?.message || String(error),
      };
      renderBridgeHealth();
      renderZones();
      if (!quiet) window.homebridge.toast.error(bridgeHealth.message, 'Hue discovery failed');
      return false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function lightMatchesEntry(light, raw) {
    const entry = normalizeId(raw);
    if (!entry) return false;
    if (entry === light.id) return true;
    if (light.id_v1 && entry === light.id_v1) return true;
    if (light.id_v1 && light.id_v1.startsWith('/lights/') && entry === light.id_v1.slice('/lights/'.length)) return true;
    return String(light.name || '').toLowerCase() === entry.toLowerCase();
  }

  function zoneHasLight(zone, light) {
    return (zone.lights || []).some((entry) => lightMatchesEntry(light, entry));
  }

  function dedupeEntries(entries) {
    const seen = new Set();
    return entries.filter((item) => {
      const value = normalizeId(item);
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function setZoneLightSelected(zone, light, selected) {
    const current = Array.isArray(zone.lights) ? zone.lights : [];
    const others = current.filter((entry) => !lightMatchesEntry(light, entry));
    if (selected) others.push(light.id);
    else removeServiceSettings(zone, light.id);
    zone.lights = dedupeEntries(others);
  }

  function ensureLightSettings(zone) {
    if (!zone.lightSettings || typeof zone.lightSettings !== 'object' || Array.isArray(zone.lightSettings)) {
      zone.lightSettings = {};
    }
    return zone.lightSettings;
  }

  function serviceSettings(zone, lightId) {
    const settings = ensureLightSettings(zone);
    const value = settings[lightId];
    return value && typeof value === 'object' ? value : {};
  }

  function setServiceSetting(zone, lightId, key, rawValue) {
    const settings = ensureLightSettings(zone);
    const current = { ...(settings[lightId] || {}) };
    if (rawValue === '' || rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))) {
      delete current[key];
    } else {
      current[key] = Number(rawValue);
    }
    if (Object.keys(current).length) settings[lightId] = current;
    else delete settings[lightId];
    scheduleSync();
  }

  function removeServiceSettings(zone, lightId) {
    const settings = ensureLightSettings(zone);
    if (Object.prototype.hasOwnProperty.call(settings, lightId)) delete settings[lightId];
  }

  function unresolvedEntries(zone) {
    if (!discoveredLights.length) return Array.isArray(zone.lights) ? zone.lights : [];
    return (zone.lights || []).filter((entry) => !discoveredLights.some((light) => lightMatchesEntry(light, entry)));
  }

  function renderManualEntries(zone, container, entries) {
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'small text-muted mb-2';
      empty.textContent = 'No manual or unresolved light identifiers.';
      container.appendChild(empty);
    }

    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'hmr-light-row';
      row.innerHTML = `
        <input class="form-control form-control-sm" type="text" placeholder="Exact Hue light name or ID">
        <button class="btn btn-outline-danger btn-sm" type="button" aria-label="Remove light">Remove</button>
      `;
      const input = $('input', row);
      input.value = entry;
      input.addEventListener('input', () => {
        const index = zone.lights.indexOf(entry);
        if (index >= 0) zone.lights[index] = input.value;
        entry = input.value;
        scheduleSync();
      });
      $('button', row).addEventListener('click', () => {
        const index = zone.lights.indexOf(entry);
        if (index >= 0) zone.lights.splice(index, 1);
        renderZones();
        scheduleSync();
      });
      container.appendChild(row);
    });
  }

  function featureLabels(light) {
    const labels = [];
    if (light.features?.color) labels.push('Color');
    if (light.features?.colorTemperature) labels.push('White');
    if (light.features?.dimming) labels.push('Dimmable');
    return labels;
  }

  function renderServiceOverride(zone, light, root) {
    const settings = serviceSettings(zone, light.id);
    const details = document.createElement('details');
    details.className = 'hmr-service-override mt-2';
    details.open = Object.keys(settings).length > 0;
    details.innerHTML = `
      <summary class="small fw-semibold">Individual motion override</summary>
      <div class="small text-muted mt-1 mb-2">Leave blank to inherit the zone setting. This lets each light service of a multi-zone fixture use a different motion state.</div>
      <div class="row g-2">
        <div class="col-sm-6">
          <label class="form-label small mb-1">Brightness (%)</label>
          <input class="form-control form-control-sm service-brightness" type="number" min="1" max="100" step="1" placeholder="Inherit zone">
        </div>
        <div class="col-sm-6">
          <label class="form-label small mb-1">White Temperature (mirek)</label>
          <input class="form-control form-control-sm service-temperature" type="number" min="153" max="500" step="1" placeholder="Inherit zone">
        </div>
      </div>
    `;
    const brightness = $('.service-brightness', details);
    const temperature = $('.service-temperature', details);
    brightness.value = settings.brightness ?? '';
    temperature.value = settings.colorTemperature ?? '';
    brightness.addEventListener('input', () => setServiceSetting(zone, light.id, 'brightness', brightness.value));
    temperature.addEventListener('input', () => setServiceSetting(zone, light.id, 'colorTemperature', temperature.value));
    root.appendChild(details);
  }

  function renderFixture(zone, fixture) {
    const card = document.createElement('div');
    card.className = 'hmr-fixture';
    const services = Array.isArray(fixture.lightServices) ? fixture.lightServices : [];
    const selectedCount = services.filter((light) => zoneHasLight(zone, light)).length;
    const productName = fixture.product?.productName || fixture.archetype || '';
    const modelId = fixture.product?.modelId || '';
    const multi = services.length > 1;

    card.innerHTML = `
      <div class="hmr-fixture-head d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <div class="d-flex flex-wrap align-items-center gap-2">
            <strong class="fixture-name"></strong>
            <span class="badge ${multi ? 'text-bg-info' : 'text-bg-secondary'}">${multi ? `${services.length}-zone fixture` : 'Single-zone fixture'}</span>
          </div>
          <div class="small text-muted fixture-product"></div>
        </div>
        ${multi ? '<div class="form-check"><input class="form-check-input select-fixture" type="checkbox"><label class="form-check-label small">Entire fixture</label></div>' : ''}
      </div>
      <div class="hmr-fixture-services"></div>
      <details class="hmr-device-inspector mt-2">
        <summary class="small fw-semibold">Device inspector</summary>
        <div class="small text-muted mt-2 inspector-content"></div>
      </details>
    `;
    $('.fixture-name', card).textContent = fixture.name || 'Hue fixture';
    $('.fixture-product', card).textContent = [productName, modelId].filter(Boolean).join(' · ') || 'Hue device';

    if (multi) {
      const entire = $('.select-fixture', card);
      entire.checked = selectedCount === services.length && services.length > 0;
      entire.indeterminate = selectedCount > 0 && selectedCount < services.length;
      entire.addEventListener('change', () => {
        services.forEach((light) => setZoneLightSelected(zone, light, entire.checked));
        scheduleSync();
        renderZones();
      });
    }

    const serviceHost = $('.hmr-fixture-services', card);
    services.forEach((light, index) => {
      const selected = zoneHasLight(zone, light);
      const service = document.createElement('div');
      service.className = 'hmr-service';
      const badges = featureLabels(light)
        .map((value) => `<span class="badge text-bg-secondary hmr-feature-badge">${value}</span>`)
        .join(' ');
      const serviceLabel = light.serviceName && light.serviceName !== fixture.name
        ? light.serviceName
        : (multi ? `Light service ${Number.isFinite(light.serviceId) ? light.serviceId : index + 1}` : fixture.name || light.name || light.id);
      service.innerHTML = `
        <div class="form-check">
          <input class="form-check-input service-select" type="checkbox" ${selected ? 'checked' : ''}>
          <label class="form-check-label fw-semibold service-label"></label>
        </div>
        <div class="d-flex flex-wrap gap-1 mt-1">${badges}</div>
        <div class="hmr-light-meta mt-1"></div>
      `;
      $('.service-label', service).textContent = serviceLabel;
      $('.hmr-light-meta', service).textContent = `Service ${Number.isFinite(light.serviceId) ? light.serviceId : '—'} · ${light.id}`;
      $('.service-select', service).addEventListener('change', (event) => {
        setZoneLightSelected(zone, light, event.currentTarget.checked);
        scheduleSync();
        renderZones();
      });
      if (selected) renderServiceOverride(zone, light, service);
      serviceHost.appendChild(service);
    });

    const inspector = $('.inspector-content', card);
    const lines = [
      `Device UUID: ${fixture.id || 'unavailable'}`,
      `Controllable light services: ${services.length}`,
    ];
    if (modelId) lines.push(`Model: ${modelId}`);
    if (fixture.product?.softwareVersion) lines.push(`Firmware: ${fixture.product.softwareVersion}`);
    for (const light of services) {
      lines.push(`• service_id ${Number.isFinite(light.serviceId) ? light.serviceId : '—'} · ${light.serviceName || light.name || 'Light'} · ${light.id}`);
    }
    inspector.textContent = lines.join('\n');

    return card;
  }

  function renderLights(zone, container) {
    container.innerHTML = '';
    ensureLightSettings(zone);

    if (discoveredLights.length) {
      const picker = document.createElement('div');
      picker.className = 'hmr-fixture-grid';
      const fixtures = discoveredFixtures.length
        ? discoveredFixtures
        : discoveredLights.map((light) => ({ id: light.ownerId || light.id, name: light.name || light.id, product: {}, lightServices: [light] }));
      fixtures.forEach((fixture) => picker.appendChild(renderFixture(zone, fixture)));
      container.appendChild(picker);

      const unresolved = unresolvedEntries(zone);
      const details = document.createElement('details');
      details.className = 'hmr-manual-details';
      details.open = unresolved.length > 0;
      details.innerHTML = `
        <summary class="small fw-semibold">Manual / unresolved identifiers (${unresolved.length})</summary>
        <div class="small text-muted my-2">Use this only for a light service that is unavailable to discovery or when entering a Hue resource ID manually.</div>
        <div class="manual-list"></div>
        <button class="btn btn-outline-secondary btn-sm mt-2 add-manual" type="button">+ Add Manual Identifier</button>
      `;

      renderManualEntries(zone, $('.manual-list', details), unresolved);
      $('.add-manual', details).addEventListener('click', () => {
        zone.lights.push('');
        renderZones();
        scheduleSync();
      });
      container.appendChild(details);
      return;
    }

    const empty = document.createElement('div');
    empty.className = 'small text-muted mb-2';
    empty.textContent = zone.lights.length
      ? 'Hue discovery is not currently available. Existing identifiers are shown below.'
      : 'No Hue lights assigned yet. This zone can remain disabled and staged.';
    container.appendChild(empty);
    const manual = document.createElement('div');
    renderManualEntries(zone, manual, zone.lights);
    container.appendChild(manual);
    const add = document.createElement('button');
    add.className = 'btn btn-outline-secondary btn-sm mt-2';
    add.type = 'button';
    add.textContent = '+ Add Manual Identifier';
    add.addEventListener('click', () => {
      zone.lights.push('');
      renderZones();
      scheduleSync();
    });
    container.appendChild(add);
  }

  function renderZone(zone, index) {
    const el = document.createElement('div');
    el.className = 'hmr-zone';
    el.dataset.disabled = String(!zone.enabled);
    el.innerHTML = `
      <div class="hmr-zone-head d-flex flex-wrap justify-content-between align-items-center gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <strong class="zone-title"></strong>
          <span class="badge zone-state"></span>
          <span class="badge text-bg-info legacy-badge d-none">Existing Pulse</span>
          <span class="badge text-bg-secondary primary-badge d-none">Default Test Zone</span>
        </div>
        <div class="d-flex gap-1 hmr-drag-buttons">
          <button class="btn btn-outline-secondary btn-sm move-up" type="button" title="Move up">↑</button>
          <button class="btn btn-outline-secondary btn-sm move-down" type="button" title="Move down">↓</button>
          <button class="btn btn-outline-danger btn-sm delete-zone" type="button">Delete</button>
        </div>
      </div>
      <div class="hmr-zone-body">
        <div class="row g-3 mb-3">
          <div class="col-md-7">
            <label class="form-label">Zone Name</label>
            <input class="form-control zone-name" type="text">
          </div>
          <div class="col-md-5">
            <label class="form-label">Stable Zone ID</label>
            <div class="form-control-plaintext font-monospace hmr-zone-id"></div>
          </div>
        </div>
        <div class="d-flex flex-wrap gap-4 mb-2">
          <div class="form-check form-switch">
            <input class="form-check-input zone-enabled" type="checkbox">
            <label class="form-check-label">Enabled</label>
          </div>
          <div class="form-check">
            <input class="form-check-input zone-primary" type="radio" name="primaryZone">
            <label class="form-check-label">Primary Zone</label>
          </div>
        </div>
        <div class="text-muted hmr-zone-services mb-3">Apple Home accessory: MotionGuard - ${zone.name || 'Zone'} · services depend on Apple Home Exposure profile</div>
        <div class="hmr-muted-box mb-3">
          <div class="d-flex justify-content-between align-items-center mb-2 gap-2">
            <div>
              <div class="fw-semibold">Hue Lights</div>
              <div class="small text-muted">${discoveredLights.length ? 'Select entire fixtures or individual light services. Multi-zone fixtures are grouped automatically. Stable v2 service UUIDs are saved.' : 'Discover the bridge to pick fixtures/light services, or use manual identifiers.'}</div>
            </div>
            ${discoveredLights.length ? `<span class="badge text-bg-secondary">${discoveredFixtures.length || discoveredLights.length} fixture(s) · ${discoveredLights.length} service(s)</span>` : ''}
          </div>
          <div class="lights-list"></div>
        </div>
        <details>
          <summary class="fw-semibold mb-2">Per-zone overrides</summary>
          <div class="hmr-option-grid overrides"></div>
        </details>
      </div>
    `;

    $('.zone-title', el).textContent = zone.name || `Zone ${index + 1}`;
    const stateBadge = $('.zone-state', el);
    stateBadge.textContent = zone.enabled ? 'Enabled' : 'Staged';
    stateBadge.className = `badge zone-state ${zone.enabled ? 'text-bg-success' : 'text-bg-secondary'}`;
    $('.legacy-badge', el).classList.toggle('d-none', !zone.legacyTrigger);
    $('.primary-badge', el).classList.toggle('d-none', !zone.primary);
    $('.hmr-zone-id', el).textContent = zone.id;

    const nameInput = $('.zone-name', el);
    nameInput.value = zone.name;
    nameInput.addEventListener('input', () => {
      zone.name = nameInput.value;
      $('.zone-title', el).textContent = zone.name || `Zone ${index + 1}`;
      scheduleSync();
    });

    const enabledInput = $('.zone-enabled', el);
    enabledInput.checked = zone.enabled;
    enabledInput.addEventListener('change', () => {
      zone.enabled = enabledInput.checked;
      renderZones();
      scheduleSync();
    });

    const primaryInput = $('.zone-primary', el);
    primaryInput.checked = zone.primary;
    primaryInput.addEventListener('change', () => {
      ensureSinglePrimary(config.zones, index);
      renderZones();
      scheduleSync();
    });

    $('.move-up', el).disabled = index === 0;
    $('.move-down', el).disabled = index === config.zones.length - 1;
    $('.move-up', el).addEventListener('click', () => {
      [config.zones[index - 1], config.zones[index]] = [config.zones[index], config.zones[index - 1]];
      renderZones();
      scheduleSync();
    });
    $('.move-down', el).addEventListener('click', () => {
      [config.zones[index + 1], config.zones[index]] = [config.zones[index], config.zones[index + 1]];
      renderZones();
      scheduleSync();
    });

    $('.delete-zone', el).addEventListener('click', () => {
      const warning = zone.legacyTrigger
        ? `Delete ${zone.name}? This zone owns the existing legacy Ring Motion Pulse accessory. Its HomeKit automation will be removed after restart.`
        : `Delete ${zone.name}? Its MotionGuard zone accessory and Apple Home services will be removed after restart.`;
      if (!window.confirm(warning)) return;
      config.zones.splice(index, 1);
      ensureSinglePrimary(config.zones);
      renderZones();
      scheduleSync();
    });

    renderLights(zone, $('.lights-list', el));

    const overrides = $('.overrides', el);
    const brightness = zoneNumberInput('Brightness (%)', 'brightness', zone.brightness, 1, 100, 1);
    brightness.zone = zone;
    const temp = zoneNumberInput('White Temperature (mirek)', 'colorTemperature', zone.colorTemperature, 153, 500, 1);
    temp.zone = zone;
    const delay = zoneNumberInput('Restore Delay (seconds)', 'delaySeconds', zone.delaySeconds, 5, 3600, 1);
    delay.zone = zone;
    const max = zoneNumberInput('Maximum Override (seconds)', 'maxOverrideSeconds', zone.maxOverrideSeconds, 60, 7200, 1);
    max.zone = zone;
    const night = zoneOptionalBoolean('Night Only', 'nightOnly', zone);
    [brightness, temp, delay, max, night].forEach((item) => overrides.appendChild(item));

    return el;
  }

  function renderDiscoveryHint() {
    const hint = $('#discoveryHint');
    if (discoveredLights.length) {
      hint.classList.add('d-none');
      return;
    }
    hint.classList.remove('d-none');
    hint.textContent = bridgeCredentialsReady()
      ? 'No Hue light inventory is loaded yet. Press Discover / Refresh Lights. Existing manual identifiers remain supported.'
      : 'Complete the Hue Bridge security fields, then use Discover / Refresh Lights to populate light pickers.';
  }

  function renderZones() {
    const host = $('#zones');
    host.innerHTML = '';
    const zones = Array.isArray(config.zones) ? config.zones : [];
    $('#zoneEmpty').classList.toggle('d-none', zones.length !== 0);
    zones.forEach((zone, index) => host.appendChild(renderZone(zone, index)));
    renderLegacyBanner();
    renderDiscoveryHint();
    window.homebridge.fixScrollHeight?.();
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    window.homebridge.showSpinner?.();
    try {
      const blocks = await window.homebridge.getPluginConfig();
      config = normalizeLocalConfig(blocks[0] || {});
      const version = window.homebridge.plugin?.installedVersion;
      if (version) $('#versionBadge').textContent = `v${version}`;
      setBasicFields();
      renderBridgeHealth();
      renderZones();
      renderLegacyBanner();
      window.homebridge.enableSaveButton();
    } catch (error) {
      window.homebridge.toast.error(error.message || String(error), 'MotionGuard for Hue UI failed to load');
    } finally {
      window.homebridge.hideSpinner?.();
    }

    if (bridgeCredentialsReady()) {
      await discoverHueLights({ quiet: true });
    }
  }

  $$('.config-field').forEach((field) => field.addEventListener('input', () => {
    readBasicField(field);
    if (['bridgeHost', 'bridgeId', 'certificateFingerprint', 'hueApplicationKey'].includes(field.dataset.key)) {
      bridgeHealth = { state: 'unknown', checkedAt: null, lightCount: null, message: '' };
      renderBridgeHealth();
    }
  }));
  $('#debug').addEventListener('change', (event) => readBasicField(event.currentTarget));

  $('#toggleKey').addEventListener('click', () => {
    const field = $('#hueApplicationKey');
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? 'Hide' : 'Show';
  });

  $('#discoverLights').addEventListener('click', () => discoverHueLights({ quiet: false }));

  $('#addZone').addEventListener('click', () => {
    const hasLegacyLights = Array.isArray(config.lights) && config.lights.some((item) => String(item).trim());
    const hasManagedZones = Array.isArray(config.zones) && config.zones.length > 0;
    if (hasLegacyLights && !hasManagedZones) {
      convertLegacyToManaged('Current Zone');
      window.homebridge.toast.success('Your existing single-zone setup was preserved as Current Zone before adding the new zone.', 'MotionGuard for Hue');
    }
    if (!Array.isArray(config.zones)) config.zones = [];
    config.zoneManagerVersion = 2;
    config.zones.push(newZone());
    ensureSinglePrimary(config.zones);
    renderZones();
    scheduleSync();
  });

  $('#convertLegacy').addEventListener('click', () => {
    const name = $('#legacyZoneName').value.trim() || 'Legacy Zone';
    if (!convertLegacyToManaged(name)) return;
    renderZones();
    scheduleSync();
    window.homebridge.toast.success('Legacy setup converted. The existing Ring Motion Pulse identity will be preserved.', 'MotionGuard for Hue');
  });

  function boot() {
    if (!window.homebridge) {
      setTimeout(boot, 50);
      return;
    }
    window.homebridge.addEventListener?.('ready', initialize);
    setTimeout(initialize, 0);
  }

  boot();
})();
