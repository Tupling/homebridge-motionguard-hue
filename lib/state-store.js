'use strict';

const fs = require('node:fs');
const path = require('node:path');

class StateStore {
  constructor({ api, log }) {
    this.log = log;
    this.file = path.join(api.user.persistPath(), 'motionguard-hue-state.json');
    this.data = { version: 1, controls: {}, runtimes: {} };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data = {
          version: 1,
          controls: parsed.controls && typeof parsed.controls === 'object' ? parsed.controls : {},
          runtimes: parsed.runtimes && typeof parsed.runtimes === 'object' ? parsed.runtimes : {},
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn(`Could not read MotionGuard state: ${error.message}`);
    }
    return this.data;
  }

  control(zoneId) {
    return this.data.controls[zoneId] || {};
  }

  runtime(zoneId) {
    return this.data.runtimes[zoneId] || null;
  }

  async saveControl(zoneId, value) {
    this.data.controls[zoneId] = { ...value };
    await this.write();
  }

  async saveRuntime(zoneId, value) {
    if (value) this.data.runtimes[zoneId] = value;
    else delete this.data.runtimes[zoneId];
    await this.write();
  }

  async write() {
    const body = JSON.stringify(this.data, null, 2);
    const temp = `${this.file}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temp, this.file);
    }).catch((error) => {
      this.log.warn(`Could not persist MotionGuard state: ${error.message}`);
    });
    await this.writeChain;
  }
}

module.exports = { StateStore };
