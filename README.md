# HomeCast

HomeCast is a local network video casting project. A Chrome extension sends a directly reachable MP4 or HLS stream to the HomeCast receiver on an LG webOS TV. The PC runs a small Node.js server; playback stays on the home network.

> **Compatibility:** The included TV receiver is an LG webOS app. It does not install on Android/Google TV, Fire TV, Roku, Apple TV, Samsung Tizen, or other TV platforms. Those platforms need their own HomeCast receiver. The PC and Chrome setup below works on Windows, macOS, and Linux. See [TV compatibility](#tv-compatibility) before installing.

> **Mirror mode is experimental.** It captures a browser tab, encodes it on the PC, and sends a live HLS stream to the TV. It currently can freeze on one frame or have no audio on some Chrome/TV combinations. The project welcomes fixes and calibration reports; see [Mirror mode](#mirror-mode-experimental).

## Features

- Cast ordinary MP4 and HLS sources from Chrome to the included webOS receiver.
- Scan the current page for video elements and media URLs.
- Optionally reload a page and observe media request URLs to discover ordinary MP4/HLS streams.
- Mirror a selected Chrome tab through PC-side FFmpeg encoding to H.264/AAC HLS.
- Control playback, seeking, volume, and Stop from the extension popup or Magic Remote.
- Pair the PC server and receiver with a shared token; no cloud account or relay server is used.

## How it works

```text
Chrome extension ── LAN HTTP/WebSocket ──> Node.js server ── WebSocket ──> HomeCast webOS app
         │                                      │                            │
         └── direct MP4/HLS URL                 └── mirror: FFmpeg HLS ─────┘
```

Direct casting asks the TV to fetch the source through the PC proxy. Mirror mode captures the selected tab in a separate HomeCast extension window, sends WebM chunks to the PC, and has FFmpeg produce a local HLS playlist and segments. Mirror mode is not a DRM workaround.

## Requirements

- A PC and LG webOS TV on the same trusted home network. Guest Wi-Fi and client/AP isolation must be disabled between them.
- Node.js 18 or newer and npm on the PC.
- Google Chrome desktop for the extension. Other Chromium browsers may work, but are not part of the verified setup.
- For mirror mode only: FFmpeg with `libx264` and AAC encoders available on the PC.
- For TV installation: LG webOS Developer Mode app and the current [webOS TV CLI](https://webostv.developer.lge.com/develop/tools/webos-tv-cli-installation).

## Install the PC server

Clone or download this repository, then run these commands from its directory:

```sh
npm ci
```

Copy `.env.example` to `.env`. Set `PAIRING_TOKEN` to a private random value. You can generate one with:

```sh
node -p "require('crypto').randomBytes(24).toString('hex')"
```

Set `PORT` if port 3000 is already in use. Start the server:

```sh
npm start
```

The server prints its LAN address. Use that address from both the Chrome extension and TV app, for example `192.168.1.20`, with port `3000`. Do not use `localhost` or `127.0.0.1` on the TV.

### Firewall

Allow inbound TCP traffic to the server port only on your private home network.

**Windows PowerShell (run as Administrator):**

```powershell
New-NetFirewallRule -DisplayName "HomeCast Node" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
```

Change `3000` if you changed `PORT`. To remove the rule later:

```powershell
Remove-NetFirewallRule -DisplayName "HomeCast Node"
```

**Linux with UFW:**

```sh
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
```

Replace `192.168.1.0/24` with your home LAN's subnet and `3000` if you use another port.

On macOS, allow incoming connections for the Node.js runtime if the firewall asks. Do not expose the server port to the public internet or configure router port forwarding for it.

## Load the Chrome extension

1. Open `chrome://extensions` in desktop Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension` folder.
4. Open the HomeCast popup. Enter the PC LAN address and the same pairing token used in `.env`.
5. Open a page with a video and choose **Cast to LG TV**. Chrome asks for optional site/server access when needed.

Chrome stores the token in the local extension profile. Do not share browser-profile data or screenshots that reveal it. **Reload** the extension from `chrome://extensions` after pulling code changes.

### Discovering a media URL

If normal page scanning cannot find a direct URL, choose **Reload & detect stream**. This asks for optional broad HTTP(S) request access, arms observation for the selected tab for up to two minutes, and reloads that page. It stores candidate URLs and request headers needed for ordinary HLS/MP4 access; it does not read cookies, decrypt DRM, or guarantee that a site permits playback on a TV.

## Install the TV receiver (LG webOS only)

These steps apply to LG TVs that support the Developer Mode app and packaged web apps. Availability of Developer Mode and app installation depends on the TV model, region, and webOS release. LG's [Developer Mode guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) has the current device workflow.

1. Install the **Developer Mode** app from the LG Content Store and sign in with an LG Developer account.
2. Enable **Dev Mode Status** and **Key Server** in that app. Record the TV's IP address and displayed passphrase.
3. Install the current webOS TV CLI using LG's [official CLI installation guide](https://webostv.developer.lge.com/develop/tools/webos-tv-cli-installation). LG marks the older `@webosose/ares-cli` npm package as deprecated; use the current webOS TV CLI instructions.
4. Add the TV as a target with the CLI's interactive setup:

   ```sh
   ares-setup-device
   ```

   Add a device name such as `tv`, enter the TV IP, port `9922`, and SSH user `prisoner`. Save it, then retrieve the key (replace `tv` if you chose another name):

   ```sh
   ares-novacom --device tv --getkey
   ```

   Enter the passphrase shown in the Developer Mode app when prompted. Check the connection:

   ```sh
   ares-device --system-info --device tv
   ```

5. From the repository root, package, install, and launch the receiver:

   ```sh
   ares-package tv
   ares-install --device tv com.homecast.player_1.0.2_all.ipk
   ares-launch --device tv com.homecast.player
   ```

   `ares-package` writes the `.ipk` in its working directory. Its filename uses the app ID and version in `tv/appinfo.json`; adjust the install filename if you change that version.

6. In the HomeCast TV app, open Settings and enter the PC LAN address, port, and same pairing token. Save and wait for the connected status.
7. Keep Developer Mode active while testing. Its session expires; use **Extend** in the TV's Developer Mode app before it expires. LG notes that after the session expires, Developer Mode apps are removed and must be installed again.

## TV compatibility

| Device/platform | Status |
|---|---|
| LG webOS TV with Developer Mode app | Supported target for the included receiver; tested development target is an older webOS 3.x TV. Other model and firmware combinations still need testing. |
| Android TV / Google TV | Not supported by the included receiver. A native Android receiver is needed. |
| Amazon Fire TV | Not supported by the included receiver. A Fire TV receiver is needed. |
| Samsung Tizen | Not supported by the included receiver. A Tizen receiver is needed. |
| Roku | Not supported by the included receiver. A Roku receiver/channel is needed. |
| Apple TV | Not supported by the included receiver. A tvOS receiver is needed. |
| Other smart TVs | Not supported unless they can run a compatible HomeCast receiver app. |

The direct-source and mirror flows use a HomeCast-specific WebSocket control message. An arbitrary TV browser or built-in casting feature cannot receive it automatically. To add another TV platform, implement the receiver UI and the same pairing/cast/control protocol for that platform; contributions are welcome.

The app targets conservative H.264/AAC HLS for older webOS devices. LG's [streaming specification](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm) lists unsupported native-player tags; HomeCast avoids `EXT-X-INDEPENDENT-SEGMENTS` and emits HLS version 3 for compatibility. Actual codec/profile/bitrate support varies by model and firmware. See [LG's video/audio formats](https://webostv.developer.lge.com/develop/specifications/video-audio).

## Mirror mode (experimental)

Mirror mode opens a small HomeCast extension window. Select the source tab in Chrome's picker and turn on **Share audio**. Keep the HomeCast capture window open. The PC captures the tab, transcodes it to H.264/AAC HLS, and sends the local stream to the TV. Expect several seconds of latency and substantial PC CPU use.

**Known limitation:** mirror mode is not reliable across all Chrome builds, pages, and webOS devices. Reports include a frozen first frame, stalled playback, or missing audio. If Chrome's picker does not share audio, the stream is video-only; the capture window reports whether an audio track was received. Some protected or GPU-rendered video surfaces can still be black or silent. This project does not bypass DRM.

Help improve it by opening an issue with the Chrome version, PC OS, TV model/webOS version, whether the capture window reports an audio track, and whether the TV's playback time advances. Do not include pairing tokens, private stream URLs, or account details. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Controls

- Extension popup: Play, Pause, seek, volume, and Stop.
- LG Magic Remote: **OK** toggles pause/resume; **Up/Down** changes HomeCast video volume; **Back/Stop** stops playback.
- TV system volume buttons continue to change the TV's output volume.

## Security and privacy

- Keep HomeCast on a trusted LAN. The server binds to network interfaces so the TV can connect; do not publish it to the internet.
- Choose a random pairing token. The extension and TV app both need the same value.
- `/cast`, `/control`, and WebSocket control require the pairing token. The HLS mirror path is reachable by devices on the LAN while a random session ID is active so the TV player can fetch segments.
- The optional request observer records only media URL/type and matching Referer/Origin metadata for the selected tab, for up to two minutes. It does not read request bodies or cookies.
- The proxy accepts public HTTP(S) targets and blocks private/loopback destinations. Some origin servers require cookies or DRM licenses and cannot be proxied.
- Never commit `.env`, pairing tokens, TV passphrases, or private media URLs.

## Troubleshooting

| Symptom | Checks |
|---|---|
| Extension says server unavailable | Confirm `npm start` is running, use the PC's LAN IP and correct port, allow the private-network firewall rule, and check that the TV and PC are not on isolated guest Wi-Fi. |
| TV shows waiting for a cast | Check the TV app's server address/token and verify the TV reports connected in the extension popup. |
| Direct cast is black or fails | The source may be a blob/MSE stream, require login cookies, use MPEG-DASH, or use a codec/profile the TV cannot play. Try a public H.264/AAC MP4 or HLS source. |
| Mirror stops at a still frame | Check that playback time advances on the TV, leave the HomeCast capture window open, and include the browser/TV versions in a report. Mirror is experimental. |
| Mirror has no audio | Stop and start again; choose the browser **tab** and enable Chrome's **Share audio** option. Confirm the HomeCast window says it captured an audio track. |
| `ffmpeg` not found | Install FFmpeg and ensure `ffmpeg` is on `PATH`, or set `FFMPEG_PATH` in `.env` to the executable. Confirm that build includes `libx264` and AAC. |
| TV reports a playback/codec error | Use the TV-compatible H.264/AAC HLS path. Direct casting does not transcode; mirror mode does. Check the PC server console for FFmpeg errors. |
| Developer Mode expired | Re-enable Developer Mode and Key Server, retrieve the key if required, then reinstall and relaunch the app. |

## Development

```text
server.js          LAN HTTP/WebSocket server, proxy, and FFmpeg HLS worker
extension/         Chrome MV3 extension and mirror capture window
tv/                LG webOS packaged receiver
```

The TV app uses older Chromium-compatible JavaScript and CSS for legacy webOS. If changing player or UI code, check the target engine and test on a physical TV; a desktop browser does not reproduce webOS media playback.

## License

HomeCast is released under the MIT License. See [LICENSE](LICENSE).
