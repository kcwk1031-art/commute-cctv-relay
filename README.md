# CCTV Media Relay

This service receives an official MJPEG camera feed, rebuilds its timestamps from actual arrival time, converts it to low-latency HLS, and exposes a health endpoint. iPhone Safari can play the resulting `index.m3u8` through a native `<video>` element. The relay reconnects automatically when an upstream MJPEG response ends.

## Local test

`ffmpeg` must be installed and available on `PATH`.

最簡單方式：雙擊 `啟動影像服務.cmd`，再在同一台電腦的瀏覽器開啟
`http://localhost:8788/player`。

或在 PowerShell 執行：

```powershell
cd media-relay
npm start
```

Check `http://localhost:8788/health`. When state is `ready`, the HLS playlist is:

建議直接觀看：`http://localhost:8788/player`

這是將官方 MJPEG 轉為瀏覽器可顯示的標準 JPEG MJPEG，避免 Chrome 黑屏與 HLS 緩衝卡頓。HLS 診斷頁保留於 `http://localhost:8788/hls-player`，不作為目前建議方案。

HLS 播放清單仍可供技術測試：

`http://localhost:8788/streams/30001/index.m3u8`

`localhost` 只代表這台電腦，手機不能用此網址。手機要觀看，必須將本服務部署到可公開存取的 Docker 主機，取得 HTTPS 網址後才可連線。

## App integration

The driving app uses two public HTTPS service URLs:

1. `鏡頭目錄 Proxy 網址`: the existing Cloudflare Worker URL, which exposes `/v1/cameras`.
2. `即時影像 Relay 網址`: this Docker service URL.

Deploy the relay with `CAMERA_CATALOG_URL=https://<your-worker>/v1/cameras`. The relay resolves the selected camera ID through that catalog server-side and exposes it as `/mjpeg/<camera-id>`. The browser never receives a TDX credential.

## Production requirement

Deploy this Docker service on an always-on container host. GitHub Pages cannot perform MJPEG-to-HLS transcoding. The deployed service URL is then used by the web app's native HLS player.

## Health rule

No new HLS segment for 12 seconds is `stale`; the relay kills and restarts that camera process. A player must display a reconnecting state rather than claim the image is live.

## Source-rate limit

The tested official camera feed supplies roughly five frames per second. The source reports 25fps timestamps despite that arrival rate, so the relay stretches the timestamp timeline fivefold before HLS conversion. This produces continuous real-time 5fps playback rather than a fast burst followed by a freeze. It cannot create genuine 25/30-fps video; that would require a separately licensed higher-frame-rate source.
