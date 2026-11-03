# Backend — LongN Art-Net 輸出、控制 API 與天氣

後端持續把與 frontend `EffectPreset v2` 一致的效果算成影格，以 Art-Net 送到 5 台 LongN 控制盒；同一個程序在 `0.0.0.0:8765` 提供前端頁面與控制 API。Python 3.12，以 uv 管理，唯一的第三方套件是 `stupidartnet==1.6.0`（不自行實作 Art-Net 封包，也不查詢接收端）。

完整規格（效果引擎、API 欄位、設定格式、天氣規則）見 [`system-reference.md`](../system-reference.md)；Windows 部署見 [`deploy/README.md`](deploy/README.md)。

## 送出什麼

每台每影格一包 512 bytes，同一包送到該台設定的每個 universe（LongN 控制盒的 U0 → DMX → 馬達、U1 → SPI → LED）：

| Channel | 內容 |
|---|---|
| 1–456 | 152 顆 LED，`GRB`，亮度 0.4；該台全速時套用月亮校正（兩腳漸暗、頂點壓到 0.3） |
| 457 | 馬達速度：停 0、中速 60、全速 230 |
| 458 | 馬達方向：順 0、逆 255 |
| 459–512 | 0 |

- 152 顆各自由效果計算（LongN 原本是 76 色前後鏡像）。版面、亮度、色序與馬達數值都可在 `[hardware]`、`[motor]` 調整，預設就是 LongN；golden test（`tests/test_hardware.py`）和 LongN 的 `Artnet.pde` 逐 byte 比對。
- 馬達只能從 API 或控制頁手動設定（每台各自的速度與方向），串接不會改變轉速；後端啟動時一律停止。
- 結束時（正常結束、Ctrl+C、SIGTERM、Windows 服務停止、例外）每個 universe 送兩次全 0：燈全暗、馬達停。斷電、當機或網路中斷時無法保證送達；控制盒收不到 Art-Net 時**不會**自己停馬達。這不是緊急停止。
- `stupidArtnet` 的 `send()` 沒有接收確認，實際顯示要在現場確認。

## 檔案

- `config.example.toml`：LongN 現場設定（5 台、`2.0.0.101`–`105`、`universes = [0, 1]`、152 顆、5 台、`[hardware]`、`[motor]`）。本機使用時複製成不進版控的 `config.toml`。現場建議取消 `source_ip = "2.0.0.99"` 的註解，把 Art-Net 綁在 Ethernet：沒有綁定時，網路線一拔，封包會改走 Wi-Fi 送到公網的 2.0.0.x。
- `preset.example.json`：效果範例。範例 TOML 的 `render.preset` 指向它，本機使用時請改成不進版控的 `preset.json`（複製一份），因為控制頁套用效果時會覆寫 `render.preset` 指向的檔案。Windows 安裝時會自動改到 `preset\preset.json`。
- `sequence.example.json`：串接範例；實際只使用 `render.sequence` 指向的一份 `sequence.json`，不存在時以目前 preset 建立單段串接。
- 路徑都相對於 TOML 檔所在目錄。preset／sequence／palette 一律原子寫入。

## 本機執行（開發機）

在 repository 根目錄：

```bash
uv sync --locked --project backend
uv run --locked --project backend python backend/run.py --check --config backend/config.toml
uv run --locked --project backend python backend/run.py --config backend/config.toml
```

- 最後一行持續輸出並同時提供頁面與 API，按 `Ctrl+C` 停止（會先送全 0）。
- `--api-only`：只提供 API 與頁面、不送 Art-Net（編輯串接、測試 UI 用）。
- `--seconds 10`：短時間測試。`--api-port`、`--api-host 127.0.0.1`：改 port 或只讓本機連線。
- 沒有接控制器時，請把 targets 改成 `127.0.0.1`（每台不同 universe），不要把 Art-Net 送到 2.0.0.x。
- 前端：先在 `frontend/` 執行 `npm run build`，後端會自動提供 `frontend/dist`；或用 `--frontend-dir` 指定。前端開發伺服器（`npm run dev`）的 `/api` 會代理到 `127.0.0.1:8765`。

## API 摘要

同源 JSON，無驗證、無 CORS，只應開在受信任的區網（Windows 防火牆只在私人網路開放 8765）。欄位細節見 `system-reference.md` 第 4 節。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/state` | 目前效果、馬達（每台）、硬體（色序、亮度、月亮校正）與輸出設定 |
| PUT | `/api/preset` | 套用單一效果（寫入 `preset.json`） |
| PUT | `/api/motor` | `{"unitIds"?, "speed"?, "direction"?}`，例如 `{"speed":"stop"}` 全部停止 |
| PUT | `/api/hardware` | `{"moonCorrection": true\|false}` |
| GET／PUT | `/api/sequence` | 讀／存串接（存檔後從頭播放） |
| PUT | `/api/playback/restart` | `{"source":"sequence"\|"single"}` 從頭重播 |
| GET | `/api/playback` | 輸出迴圈目前位置與每台馬達狀態 |
| GET／PUT／DELETE | `/api/test/units` | 單色測試 |
| GET／PUT／DELETE | `/api/weather`、`/api/weather/override`、`/api/weather/visit`、`/api/weather/palette` | 天氣（需 `[weather]`） |

馬達狀態、月亮校正開關、單色測試、天氣手動測試都只在記憶體，重啟後回到預設（馬達一律停止、月亮校正回到 config）。

## 天氣

在 `config.toml` 加入 `[weather]`（現場座標）即啟用；後端每 15 分鐘向 Open-Meteo 讀取氣溫與天氣代碼，不阻塞 Art-Net 影格，失敗時保留上一筆。

- 晴天各台同相；多雲／霧時每台錯開 `cloud_step` 影格；降水時效果改用雨天線條版本。氣溫依色盤（`/palette.html` 編輯）覆蓋畫面顏色，不改寫 preset／sequence；效果的 `color.weatherPalette: false` 可保留自己的顏色。
- `[[weather.visits]]`：每個整點依電腦本地時間輪流造訪其他地點一輪（現場電腦時區為台北）。
- 手動測試天氣、立即造訪等操作與完整規則見 `system-reference.md` 第 6 節。

## 測試

```bash
cd backend
uv run --locked python -m unittest discover -s tests -v
```

包含：前端產生的 golden vectors（156 × 9 與 LongN 152 × 5）、LongN 封包 golden test、設定驗證、API（422／415／413）、本機 Art-Net UDP 接收、實際啟動後端並用 SIGTERM／SIGINT 停止確認送出全 0、Windows 發布腳本的靜態檢查與 zip 建置。`docs/` 是參考系統的早期規劃，不代表目前的程式。
