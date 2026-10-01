#!/usr/bin/env node
'use strict';

const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const os = require('node:os');
const readline = require('node:readline');
const { normalizeBridgeId, normalizeFingerprint, isPrivateBridgeAddress, PinnedTlsAgent } = require('../lib/hue-client');

const host = process.argv[2];
if (!host) {
  console.error('Usage: node scripts/link-hue.js <hue-bridge-private-ip>');
  process.exit(1);
}
if (!net.isIP(host) || !isPrivateBridgeAddress(host)) {
  console.error('For secure pairing, provide the Hue Bridge private IP address (for example 192.168.1.25).');
  process.exit(1);
}

function inspectCertificate() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    socket.setTimeout(8000, () => socket.destroy(new Error('TLS handshake timed out')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert?.raw || !cert?.fingerprint256) throw new Error('Bridge did not present a usable TLS certificate.');
        const bridgeId = normalizeBridgeId(cert.subject?.CN);
        const fingerprint = normalizeFingerprint(cert.fingerprint256);
        if (bridgeId.length < 12 || !fingerprint) throw new Error('Could not derive Hue Bridge identity from its certificate.');
        resolve({ bridgeId, fingerprint });
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

function promptEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(message, () => { rl.close(); resolve(); }));
}

function createApplicationKey(identity) {
  const deviceTypePrefix = 'homebridge-hue-motion-restore#';
  const deviceType = `${deviceTypePrefix}${os.hostname().slice(0, 40 - deviceTypePrefix.length)}`;
  const body = JSON.stringify({ devicetype: deviceType });
  const agent = new PinnedTlsAgent({ fingerprint: identity.fingerprint, bridgeId: identity.bridgeId });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      port: 443,
      path: '/api',
      method: 'POST',
      agent,
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
      },
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > 64 * 1024) req.destroy(new Error('Unexpectedly large pairing response'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(data);
          const success = Array.isArray(parsed) && parsed.find((item) => item.success?.username);
          if (success) return resolve(success.success.username);
          const apiError = Array.isArray(parsed) && parsed.find((item) => item.error);
          if (apiError) return reject(new Error(apiError.error.description || 'Hue Bridge rejected pairing'));
          reject(new Error('Unexpected Hue Bridge pairing response'));
        } catch (error) {
          reject(new Error(`Could not parse Hue Bridge pairing response: ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Hue Bridge request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const identity = await inspectCertificate();
    console.log('\nDetected Hue Bridge TLS identity:');
    console.log(`  Bridge ID:          ${identity.bridgeId}`);
    console.log(`  SHA-256 certificate: ${identity.fingerprint}`);
    console.log('\nVerify that the Bridge ID matches your Hue Bridge before continuing.');
    await promptEnter('Press the physical link button on the Hue Bridge, then press Enter here... ');

    const applicationKey = await createApplicationKey(identity);
    console.log('\nSecure pairing succeeded. Enter these values in the Homebridge plugin settings:\n');
    console.log(`Hue Bridge IP: ${host}`);
    console.log(`Hue Bridge ID: ${identity.bridgeId}`);
    console.log(`Certificate SHA-256: ${identity.fingerprint}`);
    console.log(`Hue Application Key: ${applicationKey}`);
    console.log('\nKeep the application key private. The plugin will never include it in request URLs or logs.');
  } catch (error) {
    console.error(`\nSecure Hue pairing failed: ${error.message}`);
    process.exit(2);
  }
})();
