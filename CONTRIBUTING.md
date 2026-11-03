# Contributing

Contributions are welcome, especially fixes for mirror stability, audio routing, webOS HLS playback, and receiver support for other TV platforms.

## Before opening a pull request

- Keep secrets, `.env`, pairing tokens, private URLs, TV passphrases, and personal network addresses out of commits.
- Describe the change and the TV/Chrome/OS models it affects.
- For webOS player changes, test on a physical TV when possible; desktop browser playback is not a substitute.
- For mirror changes, report whether the TV playback clock advances and whether the capture window received video and audio tracks.
- Keep TV-side JavaScript and CSS compatible with the project's older webOS browser target unless the supported-version policy is updated.

## Mirror calibration reports

Include Chrome version, PC OS, TV model and webOS version, selected Chrome picker source, whether **Share audio** was enabled, capture-window status, and observed latency/stall behavior. Redact pairing tokens and authenticated media URLs.

## Scope

The current receiver protocol is implemented for LG webOS. A new TV platform needs its own receiver app using the HomeCast pairing, cast, control, and status messages. Please open an issue first for large platform additions.
