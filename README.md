# MotionGuard for Hue

![MotionGuard for Hue](https://raw.githubusercontent.com/Tupling/homebridge-motionguard-hue/main/branding/banner.png)

[GitHub](https://github.com/Tupling/homebridge-motionguard-hue) · [Issues](https://github.com/Tupling/homebridge-motionguard-hue/issues)

> Package/platform compatibility names remain `homebridge-hue-motion-restore` and `HueMotionRestore` so existing Homebridge configurations can continue to load without being renamed.

## v0.7.0 — Fast motion + improved Apple Home controls

MotionGuard for Hue is a local-first Homebridge plugin that turns Philips Hue lights into state-preserving motion lighting using motion events already available in Apple Home.

It does **not** log in to Ring or require a second camera connection. Ring, Eufy, HomeKit sensors, cameras, shortcuts, or other HomeKit-compatible motion sources can trigger a zone by turning that zone's **Motion Pulse** switch ON.

### Motion flow

1. A camera or sensor detects motion.
2. Apple Home turns ON the matching **Motion Pulse** switch.
3. MotionGuard captures the zone's pre-motion Hue state.
4. The selected Hue lights change to the configured motion state.
5. Additional motion extends the timer without replacing the original snapshot.
6. MotionGuard restores the saved state when the timer expires.

The saved state includes on/off, brightness, color temperature, and XY color where available. **Protect Manual Changes** can keep MotionGuard from restoring over a light someone intentionally changed during the motion override.

## What's faster in v0.7

The Hue path has been redesigned to minimize work after MotionGuard receives a pulse:

- Pinned Hue TLS connections are kept alive and reused.
- A Hue API v2 Server-Sent Events stream maintains a live local light-state cache.
- Multi-light motion commands are sent concurrently instead of serially.
- Multi-light restore commands are also sent concurrently.
- Optional **Performance Logging** records MotionGuard-side trigger timing.

The Hue event stream is local to the Hue Bridge and uses `GET /eventstream/clip/v2`. Normal control remains on the local Hue API v2 resource endpoints.

Performance logging is useful when diagnosing an apparent delay because it separates time spent **before MotionGuard receives the Apple Home pulse** from time spent processing and commanding Hue after the pulse arrives.

## Apple Home experience

### Motion Pulse stays separate

Each enabled zone has a separate self-resetting **Motion Pulse** switch. This is intentionally kept as a simple automation target so existing and future Apple Home automations remain easy to understand.

For the legacy primary zone, MotionGuard attempts to reuse the existing **Ring Motion Pulse** accessory rather than making you rebuild the automation.

### Grouped MotionGuard controls

Each zone also gets one grouped MotionGuard control accessory. The legacy primary zone uses **Hue Motion Restore**; additional zones use **`<Zone Name> MotionGuard`**.

The grouped accessory contains:

- **Motion Lighting** — master enable/disable.
  - Native HomeKit brightness control from 1–100%.
  - Native HomeKit white-temperature control.
- **Night Only** — only accept normal motion triggers between sunset and sunrise.
- **Protect Manual Changes** — verify the light still looks like the motion state before restoring it.
- **Restore 30 Seconds**
- **Restore 60 Seconds**
- **Restore 90 Seconds**
- **Restore 2 Minutes**
- **Restore 5 Minutes**
- **Test Motion Lighting** — self-resetting test control that bypasses Night Only.
- **Restore Now** — immediately restore the active snapshot and self-reset.
- **Lighting Active** — read-only status indicating that a motion override is currently active.

The five restore-duration switches behave like a single selection: choosing one turns the others off. Apple Home control choices are persisted by MotionGuard.

## Apple Home automation setup

For each zone:

1. Open **Home → Automation → + → A Sensor Detects Something**.
2. Select the camera or motion sensor.
3. Choose **Detects Motion**.
4. Select the matching **Motion Pulse** accessory.
5. Set the switch to **ON**.
6. Save.

Do **not** add an OFF action. MotionGuard resets the pulse automatically so the next motion event can trigger it again.

## Dynamic zones

MotionGuard supports multiple independent lighting zones with stable IDs. Each zone can select its own Hue lights and can override brightness, white temperature, restore delay, Night Only, Protect Manual Changes, and maximum override duration.

A zone can be disabled while hardware is being staged. Renaming a managed zone does not change its stable zone ID.

## Homebridge settings UI

Open **Homebridge → Plugins → MotionGuard for Hue → Settings**.

v0.7 includes the required custom-UI entry point and provides:

- Hue Bridge health check.
- Secure Hue light discovery and inventory display.
- The normal schema configuration form for bridge, zone, defaults, coordinates, and diagnostics settings.
- A summary of the services that will appear in Apple Home.

Hue discovery uses the same certificate-pinned Hue client as the runtime.

## Night Only

Night Only uses the configured latitude and longitude to calculate local sunrise and sunset. If Night Only is enabled but valid coordinates are unavailable, MotionGuard fails closed and does not activate the motion lighting.

**Test Motion Lighting** deliberately bypasses Night Only so the zone can be tested during the day.

## Restore behavior

MotionGuard captures the first snapshot for an override and keeps it until that override ends. Repeated motion only extends the restore timer; it does not replace the snapshot with the temporary motion-lighting state.

Active snapshots are persisted so an interrupted Homebridge process can recover and finish the restore after restart.

For zones that share a Hue light, MotionGuard tracks zone ownership so one zone does not restore the light while another zone still has an active claim on it.

## Protect Manual Changes

When enabled, MotionGuard verifies current Hue state before restoring. If the light no longer resembles the state MotionGuard applied, the manual change is preserved.

If the bridge cannot be queried at restore time, MotionGuard retries rather than blindly overwriting the current light state.

## Performance logging

Enable **Performance Logging** in the plugin settings to emit timing messages such as:

```text
[Performance] Ring Motion Pulse received +0.0ms
[Performance] Default: snapshot resolved from cache +1.3ms
[Performance] Default: 4 Hue command(s) acknowledged in 37.8ms +41.2ms
```

If MotionGuard reports tens of milliseconds but the physical motion-to-light experience still takes seconds, the remaining delay is upstream of MotionGuard—typically the motion source, its Homebridge plugin, or the Apple Home automation handoff.

## Security model

Runtime Hue control and configuration discovery are intentionally local and narrowly scoped.

- Hue API v2 is used for resource control.
- The Hue API v2 event stream is used for local state updates.
- The Hue application key is sent in the `hue-application-key` header, never in a URL.
- The configured Hue Bridge must use a private or link-local IP address.
- TLS 1.2 or newer is required.
- The Hue Bridge leaf certificate is pinned by SHA-256 fingerprint.
- Bridge certificate identity is checked against the configured Bridge ID.
- Fingerprint or Bridge ID mismatch blocks Hue traffic.
- There is no plaintext Hue fallback.
- Hue responses are size-limited and normal API requests have timeouts.
- The runtime plugin opens no inbound listener and no additional TCP port.
- The Homebridge configuration UI makes no direct browser connection to the Hue Bridge.
- The Hue application key is not intentionally written to logs.

No software can guarantee that a system is impossible to compromise. The Homebridge host, local network, Apple account/home hubs, Hue Bridge, and administrator credentials remain part of the security boundary.

## Secure Hue pairing

For first-time setup:

```bash
npm run hue-link -- 192.168.1.25
```

Verify the Bridge ID, press the physical Hue Bridge button, and press Enter when prompted. Keep the returned Hue application key private.

## Compatibility

- Node.js: 22–26
- Homebridge: 2.x
- HomeKit/HAP transport
- Philips Hue Bridge using local Hue API v2

The public product name is **MotionGuard for Hue**, while the compatibility identifiers remain:

- npm package: `homebridge-hue-motion-restore`
- Homebridge platform alias: `HueMotionRestore`

## Development

```bash
npm ci
npm run check
```

CI validates the supported Node.js versions. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Support MotionGuard for Hue

If MotionGuard for Hue is useful to you, you can support continued development via PayPal:

**[Donate via PayPal](https://paypal.me/daletupling)**

Support is optional and does not unlock any features.

## Disclaimer

MotionGuard for Hue is an independent Homebridge project and is not affiliated with or endorsed by Signify/Philips Hue, Apple, Ring/Amazon, or Eufy/Anker.
