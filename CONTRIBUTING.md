# Contributing

Thanks for helping improve MotionGuard for Hue.

## Before opening an issue

- Search existing issues first.
- Do not post Hue application keys, HomeKit setup codes, passwords, or private network details.
- Include Homebridge, Node.js, plugin, and Hue Bridge firmware versions where relevant.

## Development

```bash
npm ci
npm run check
```

The test suite includes core behavior, dynamic zones, UI compatibility, branding checks, and security regression tests.

## Pull requests

Keep changes focused, add or update tests for behavior changes, and run `npm run check` before submitting.
