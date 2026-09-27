# MotionGuard for Hue

![MotionGuard for Hue](https://raw.githubusercontent.com/Tupling/homebridge-motionguard-hue/main/branding/banner.png)

[GitHub](https://github.com/Tupling/homebridge-motionguard-hue) · [Issues](https://github.com/Tupling/homebridge-motionguard-hue/issues)

> Package/platform compatibility names remain `homebridge-hue-motion-restore` and `HueMotionRestore` so existing Homebridge configurations and HomeKit accessory identities continue to work.

## v0.6.1 — Public release candidate

MotionGuard for Hue is a local-first Homebridge plugin that turns Philips Hue lights into state-preserving motion/security lighting using motion events already available in Apple Home.

It does **not** log in to Ring or require a second camera connection. Any HomeKit-compatible motion source can trigger a zone by turning that zone's **Motion Pulse** switch ON.

The lighting workflow is:

1. A camera or motion sensor detects motion.
2. Apple Home turns ON the matching zone's **Motion Pulse** switch.
3. MotionGuard snapshots the selected Hue light states.
4. Those lights change to the configured bright-white security state.
5. Additional motion extends the timer without replacing the original snapshot.
6. The exact previous state is restored when the timer expires.

The plugin preserves on/off state, brightness, color temperature, and XY color where supported. Manual-change protection can prevent the plugin from restoring over a light that someone changed while a motion override was active.

## Highlights

- Dynamic motion-lighting zones with stable HomeKit identities.
- Secure Hue API v2 discovery and runtime control.
- HTTPS-only local Hue traffic with SHA-256 certificate pinning and Bridge ID verification.
- Exact pre-motion state snapshot and restore.
- Repeated motion extends the timer without overwriting the original snapshot.
- Restart-safe persisted restore state.
- Per-zone test controls and Lighting Active indicators.
- Normal, Night, Away, and Party security modes.
- Temporary one-hour motion pause.
- No analytics or intentional telemetry.
- Motion-source agnostic: Ring, HomeKit sensors, cameras, shortcuts, and automations can trigger zones.

## Dynamic Zone Manager

From **Homebridge → Plugins → MotionGuard for Hue → Settings**, users can add, remove, rename, reorder, enable, disable, and stage zones. Hue lights can be securely discovered from the paired bridge and assigned by checkbox.

Each managed zone receives a permanent internal ID, so renaming a zone does not create a new HomeKit identity or break the automation connected to that zone's Motion Pulse switch.

A zone may also be staged before its hardware exists. Disabled zones can have zero lights until fixtures are installed.

## HomeKit services per zone

Each managed zone exposes:

1. **`<Zone Name> Motion Pulse`** — automation target. Turn ON from an Apple Home motion automation. It self-resets.
2. **`Test <Zone Name>`** — manually exercises that zone, bypassing Night Only.
3. **`<Zone Name> Lighting Active`** — reports whether that zone currently owns an active motion override.

A legacy single-zone configuration retains the original **Ring Motion Pulse** accessory identity for compatibility.

## Security model

Runtime Hue control and configuration discovery are intentionally local and narrowly scoped.

- Hue API v2 (`/clip/v2`) is used.
- The Hue application key is sent in the `hue-application-key` header, never in a URL.
- The configured Hue Bridge must use a private/link-local IP address.
- TLS 1.2 or newer is required.
- The Hue Bridge leaf certificate is pinned by SHA-256 fingerprint.
- Bridge certificate identity is verified against the configured Bridge ID.
- Fingerprint or Bridge ID mismatch blocks Hue traffic.
- There is no plaintext Hue fallback.
- Hue requests have a timeout and oversized Hue responses are rejected.
- The runtime plugin opens no inbound listener and no additional TCP port.
- The browser configuration UI makes no direct network requests.
- The custom UI server reuses the same pinned Hue client as runtime control.
- The Hue application key is not intentionally written to logs.

No software can guarantee that a system is impossible to compromise. The Homebridge host, router, Apple account/home hubs, Hue Bridge, and administrator credentials remain part of the security boundary.

## Secure Hue pairing

For first-time setup:

```bash
npm run hue-link -- 192.168.1.25
```

Verify the Bridge ID, press the physical Hue Bridge button, and press Enter when prompted. Keep the returned Hue application key private.

## Apple Home automation setup

For each zone:

1. Open **Home → Automation → + → A Sensor Detects Something**.
2. Select the camera or motion sensor.
3. Choose **Detects Motion**.
4. Select the matching **Motion Pulse** accessory.
5. Set the switch to **ON**.
6. Save.

Do **not** add an OFF action. MotionGuard resets the pulse automatically so the next motion event can trigger it again.

## Development

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Compatibility

The public product name is **MotionGuard for Hue**, while the compatibility identifiers remain:

- npm package: `homebridge-hue-motion-restore`
- Homebridge platform alias: `HueMotionRestore`

This preserves existing Homebridge configurations and HomeKit accessory identities.

## Support MotionGuard for Hue

If MotionGuard for Hue is useful to you, you can support continued development via PayPal:

**[Donate via PayPal](https://paypal.me/daletupling)**

Support is optional and does not unlock any features.

## Disclaimer

MotionGuard for Hue is an independent Homebridge project and is not affiliated with or endorsed by Signify/Philips Hue, Apple, or Ring/Amazon.
