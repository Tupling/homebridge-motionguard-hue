'use strict';

const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const FINGERPRINT_RE = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentToHueBrightness(percent) {
  return clamp(Math.round((clamp(Number(percent), 1, 100) / 100) * 254), 1, 254);
}

function hueBrightnessToPercent(value) {
  return clamp((Number(value) / 254) * 100, 0, 100);
}

function mirekToKelvin(mirek) {
  return Math.round(1000000 / mirek);
}

function kelvinToMirek(kelvin) {
  return Math.round(1000000 / kelvin);
}

function normalizeFingerprint(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
  if (compact.length !== 64) return '';
  return compact.match(/.{2}/g).join(':');
}

function normalizeBridgeId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
}

function isPrivateBridgeAddress(host) {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }

  if (ipVersion === 6) {
    const lower = host.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }

  return false;
}

function validateSecurityConfig({ host, applicationKey, certificateFingerprint, bridgeId }) {
  if (!isPrivateBridgeAddress(host)) {
    throw new Error('Hue Bridge host must be a private or link-local IP address. Hostnames and public IPs are not accepted.');
  }
  if (!String(applicationKey || '').trim()) {
    throw new Error('Hue application key is required.');
  }
  const fingerprint = normalizeFingerprint(certificateFingerprint);
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('A valid SHA-256 Hue Bridge certificate fingerprint is required. Re-run the secure link utility.');
  }
  const normalizedId = normalizeBridgeId(bridgeId);
  if (normalizedId.length < 12) {
    throw new Error('A valid Hue Bridge ID is required. Re-run the secure link utility.');
  }
  return { fingerprint, bridgeId: normalizedId };
}

class PinnedTlsAgent extends https.Agent {
  constructor({ fingerprint, bridgeId }) {
    super({ keepAlive: false, maxSockets: 2 });
    this.expectedFingerprint = normalizeFingerprint(fingerprint);
    this.expectedBridgeId = normalizeBridgeId(bridgeId);
  }

  createConnection(options, callback) {
    let finished = false;
    const done = (error, socket) => {
      if (finished) return;
      finished = true;
      callback(error, socket);
    };

    const socket = tls.connect({
      host: options.host || options.hostname,
      port: options.port || 443,
      family: options.family,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
    });

    socket.setTimeout(8000, () => {
      socket.destroy(new Error('Hue Bridge TLS handshake timed out'));
    });

    socket.once('error', (error) => done(error));
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert || !cert.raw) {
          throw new Error('Hue Bridge did not present a TLS certificate.');
        }

        const actualFingerprint = normalizeFingerprint(cert.fingerprint256);
        if (!actualFingerprint || actualFingerprint !== this.expectedFingerprint) {
          throw new Error('SECURITY: Hue Bridge TLS certificate fingerprint does not match the pinned certificate. Connection blocked.');
        }

        const certBridgeId = normalizeBridgeId(cert.subject && cert.subject.CN);
        if (!certBridgeId || certBridgeId !== this.expectedBridgeId) {
          throw new Error('SECURITY: Hue Bridge certificate identity does not match the configured Bridge ID. Connection blocked.');
        }

        socket.setTimeout(0);
        done(null, socket);
      } catch (error) {
        socket.destroy();
        done(error);
      }
    });

    return undefined;
  }
}

function normalizeV2Light(resource) {
  const brightnessPercent = Number(resource?.dimming?.brightness);
  const mirek = Number(resource?.color_temperature?.mirek);
  const mirekValid = resource?.color_temperature?.mirek_valid;
  const xy = resource?.color?.xy;
  const minCt = Number(resource?.color_temperature?.mirek_schema?.mirek_minimum);
  const maxCt = Number(resource?.color_temperature?.mirek_schema?.mirek_maximum);

  let colormode;
  if (mirekValid === true && Number.isFinite(mirek)) colormode = 'ct';
  else if (Number.isFinite(xy?.x) && Number.isFinite(xy?.y)) colormode = 'xy';
  else if (Number.isFinite(mirek)) colormode = 'ct';

  const state = {
    on: Boolean(resource?.on?.on),
  };
  if (Number.isFinite(brightnessPercent)) state.bri = percentToHueBrightness(Math.max(1, brightnessPercent || 1));
  if (Number.isFinite(mirek)) state.ct = mirek;
  if (Number.isFinite(xy?.x) && Number.isFinite(xy?.y)) state.xy = [xy.x, xy.y];
  if (colormode) state.colormode = colormode;

  return {
    id: resource.id,
    id_v1: resource.id_v1,
    name: resource?.metadata?.name || resource.id,
    archetype: resource?.metadata?.archetype || '',
    state,
    features: {
      dimming: Boolean(resource?.dimming),
      colorTemperature: Boolean(resource?.color_temperature),
      color: Boolean(resource?.color),
    },
    capabilities: {
      control: {
        ct: {
          min: Number.isFinite(minCt) ? minCt : 153,
          max: Number.isFinite(maxCt) ? maxCt : 500,
        },
      },
    },
  };
}

function copySnapshotState(light) {
  const state = light && light.state ? light.state : {};
  const snapshot = { on: Boolean(state.on) };

  if (Number.isFinite(state.bri)) snapshot.bri = state.bri;

  const mode = state.colormode;
  if (mode === 'ct' && Number.isFinite(state.ct)) {
    snapshot.ct = state.ct;
  } else if (mode === 'xy' && Array.isArray(state.xy) && state.xy.length === 2) {
    snapshot.xy = [state.xy[0], state.xy[1]];
  } else if (Number.isFinite(state.ct)) {
    snapshot.ct = state.ct;
  } else if (Array.isArray(state.xy) && state.xy.length === 2) {
    snapshot.xy = [state.xy[0], state.xy[1]];
  }

  return snapshot;
}

function buildMotionState(light, brightnessPercent, colorTemperatureMirek) {
  const minCt = Number(light?.capabilities?.control?.ct?.min);
  const maxCt = Number(light?.capabilities?.control?.ct?.max);
  const lower = Number.isFinite(minCt) ? minCt : 153;
  const upper = Number.isFinite(maxCt) ? maxCt : 500;

  return {
    on: true,
    bri: percentToHueBrightness(brightnessPercent),
    ct: clamp(Math.round(colorTemperatureMirek), lower, upper),
    transitiontime: 0,
  };
}

function stateLooksLikeMotion(currentState, expectedMotionState) {
  if (!currentState || !expectedMotionState) return false;
  if (currentState.on !== true) return false;

  if (Number.isFinite(expectedMotionState.bri) && Number.isFinite(currentState.bri)) {
    if (Math.abs(currentState.bri - expectedMotionState.bri) > 4) return false;
  }

  if (Number.isFinite(expectedMotionState.ct)) {
    if (currentState.colormode && currentState.colormode !== 'ct') return false;
    if (!Number.isFinite(currentState.ct)) return false;
    if (Math.abs(currentState.ct - expectedMotionState.ct) > 8) return false;
  }

  return true;
}

function v1LikeStateToV2(state) {
  const body = {};
  if (typeof state?.on === 'boolean') body.on = { on: state.on };
  if (Number.isFinite(state?.bri)) body.dimming = { brightness: Math.round(hueBrightnessToPercent(state.bri) * 100) / 100 };
  if (Number.isFinite(state?.ct)) body.color_temperature = { mirek: Math.round(state.ct) };
  else if (Array.isArray(state?.xy) && state.xy.length === 2) {
    body.color = { xy: { x: Number(state.xy[0]), y: Number(state.xy[1]) } };
  }
  if (Number.isFinite(state?.transitiontime)) {
    body.dynamics = { duration: Math.max(0, Math.round(state.transitiontime * 100)) };
  }
  return body;
}

function sanitizeRestoreState(snapshot) {
  return { ...snapshot, transitiontime: 0 };
}

class HueClient {
  constructor({ host, applicationKey, certificateFingerprint, bridgeId, log }) {
    const validated = validateSecurityConfig({ host, applicationKey, certificateFingerprint, bridgeId });
    this.host = host;
    this.applicationKey = String(applicationKey).trim();
    this.certificateFingerprint = validated.fingerprint;
    this.bridgeId = validated.bridgeId;
    this.log = log;
    this.agent = new PinnedTlsAgent({
      fingerprint: this.certificateFingerprint,
      bridgeId: this.bridgeId,
    });
  }

  async request(method, path, body) {
    if (!String(path).startsWith('/clip/v2/')) {
      throw new Error('Refusing non-v2 Hue API path.');
    }

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'hue-application-key': this.applicationKey,
      'Cache-Control': 'no-store',
    };

    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: this.host,
      port: 443,
      path,
      method,
      agent: this.agent,
      timeout: 8000,
      headers,
    };

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        let total = 0;

        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Hue Bridge response exceeded the 1 MiB safety limit.'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`Hue Bridge HTTP ${res.statusCode}${data ? ': ' + data.slice(0, 200) : ''}`));
            return;
          }
          if (!data) {
            resolve(undefined);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed?.errors) && parsed.errors.length) {
              reject(new Error(`Hue API v2 error: ${JSON.stringify(parsed.errors[0]).slice(0, 300)}`));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Invalid JSON from Hue Bridge: ${error.message}`));
          }
        });
      });

      req.on('timeout', () => req.destroy(new Error('Hue Bridge request timed out')));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async getLights() {
    const response = await this.request('GET', '/clip/v2/resource/light');
    const result = {};
    for (const resource of response?.data || []) {
      if (resource?.type !== 'light' || !resource.id) continue;
      const normalized = normalizeV2Light(resource);
      result[normalized.id] = normalized;
    }
    return result;
  }

  async setLightState(id, state) {
    const body = v1LikeStateToV2(state);
    if (!Object.keys(body).length) throw new Error('Refusing to send an empty Hue light state update.');
    return await this.request('PUT', `/clip/v2/resource/light/${encodeURIComponent(id)}`, body);
  }

  resolveConfiguredLights(allLights, configured) {
    const entries = Object.entries(allLights || {});
    const result = [];
    const seen = new Set();

    for (const raw of configured || []) {
      const identifier = String(raw).trim();
      if (!identifier) continue;

      let match = entries.find(([id]) => id === identifier);
      if (!match) {
        match = entries.find(([, light]) => light.id_v1 === identifier || light.id_v1 === `/lights/${identifier}`);
      }
      if (!match) {
        const lower = identifier.toLowerCase();
        const sameName = entries.filter(([, light]) => String(light?.name || '').toLowerCase() === lower);
        if (sameName.length > 1 && this.log) {
          this.log.warn(`Multiple Hue lights are named "${identifier}". Using resource ${sameName[0][0]}. Configure the v2 light UUID to disambiguate.`);
        }
        match = sameName[0];
      }

      if (!match) {
        if (this.log) this.log.warn(`Hue light not found: ${identifier}`);
        continue;
      }

      if (!seen.has(match[0])) {
        result.push({ id: match[0], light: match[1] });
        seen.add(match[0]);
      }
    }

    return result;
  }
}

module.exports = {
  HueClient,
  PinnedTlsAgent,
  buildMotionState,
  copySnapshotState,
  hueBrightnessToPercent,
  isPrivateBridgeAddress,
  kelvinToMirek,
  mirekToKelvin,
  normalizeBridgeId,
  normalizeFingerprint,
  normalizeV2Light,
  percentToHueBrightness,
  sanitizeRestoreState,
  stateLooksLikeMotion,
  validateSecurityConfig,
  v1LikeStateToV2,
};
