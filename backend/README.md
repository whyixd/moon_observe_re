# Backend — minimal Art-Net effect output

Backend 持續將與 frontend `EffectPreset v2` 一致的效果輸出為 Art-Net。它只使用 `stupidartnet==1.6.0` 發送 156 個 RGB 像素（前 468 channels）及馬達命令（channel 469）；因 ArtDmx 長度須為偶數，每包另以 channel 470 補 `0`。**不查詢、不設定 WLED，也不自行實作 Art-Net socket／封包**。預設輸出至一個 IP／universe；可設定多個 target 在同一影格輸出至九組。

每個 Art-Net 封包的 **channel 469（從 1 起算，payload index 468）** 保留作馬達命令：`0` 請求緩停關閉、`255` 請求開啟緩啟動。它不與燈點資料重疊。此程式僅送出命令值，**不保證接收端已執行、也不直接控制 SAMD21 的 D8**；轉接由 GL-C-616WL 上的 WLED usermod 完成（IO13 → SAMD21 D8，見 [firmware/wled](../firmware/wled/README.md)）。

同一程序預設在 `0.0.0.0:8765` 提供前端頁面與控制 API。`GET /api/sequence` 與 `PUT /api/sequence` 讀取／覆寫唯一的串接 JSON；儲存後從下一個影格重新開始播放。`GET /api/state` 取得目前單一效果、馬達命令與輸出設定，`PUT /api/preset` 可暫時切換到單一效果，後端重新啟動或再次儲存串接時恢復串接播放。`GET /api/playback` 唯讀回報輸出迴圈目前的播放位置：串接模式含段落索引與 `id`、段內影格、第幾次重複、轉場與結束狀態；單一效果模式含效果週期。`PUT /api/playback/restart` 接收 `{"source":"sequence"}` 或 `{"source":"single"}`，從第 0 影格重播已儲存的串接或已套用的單一效果，不改寫任何檔案（前端「後端」分頁的「從頭播放」按鈕）。`restart` 在儲存串接、切換單一效果、呼叫重新播放、天氣類別改變或整點造訪開始／結束而從頭播放時遞增；`ageMs` 為取樣至回應的毫秒數，前端可依 `fps` 在兩次輪詢之間自行推進。`--api-only` 或輸出尚未開始時回傳 `{"active":false}`。此位置是後端送出的影格，不代表接收端確實顯示。`PUT /api/motor` 接收 `{"enabled":true}` 或 `{"enabled":false}`。輸出迴圈在下一個影格使用新狀態，不重建 Art-Net 連線。Preset 原子保存；馬達命令不保存，後端重啟時預設為 `0`。正常退出且先前輸出為 `255` 時會嘗試再送一個 `0` 封包。斷電、程式崩潰或網路中斷時無法保證送達，接收端需有失聯停機機制；此功能不是緊急停止。前端與 API 使用同一網址；現場區網內可直接以 Raspberry Pi IP 開啟頁面。後端不提供 WLED 控制。

單色測試（前端「後端」分頁）：`PUT /api/test/units` 接收 `{"colors":[…],"seconds":…}`，`colors` 依 unit 順序列出 `unit_count` 個 `{"r","g","b"}`（0–1）或 `null`，被指定的燈台整條燈帶以該顏色全亮、跳過效果計算，`null` 的燈台照常播放（至少要指定一台）；`seconds` 為 1–86400 秒後自動結束，或 `null` 表示維持到 `DELETE /api/test/units`。`GET /api/test/units` 回報 `active`、`colors` 與 `remainingSeconds`（手動結束時為 `null`）。測試進行中時 `GET /api/playback` 也會附上 `unitColors`（同 `colors`），前端「後端控制」的 3D 畫面據此顯示測試顏色。測試只存在記憶體，後端重啟即結束；馬達命令照舊，底下的串接或效果與天氣造訪照常前進，結束後接回當下進度、不重播。v0.1.8（含）以前的後端沒有這個 API。

## 設定

- `config.toml`：本機 Art-Net 目的 IP、universe（從 **0** 開始）或多個 target、可選來源 IP、FPS、RPM、燈組索引、天氣座標，以及 preset／sequence JSON 路徑。此本機檔不進版控；新機器可複製 `config.example.toml` 為 `config.toml`，再填入實際 IP。
- `preset.example.json`：前端同版的效果、顏色與參數範例。實際運行建議複製為不進版控的 `preset.json`，並在 TOML 的 `render.preset` 指定它；控制模式會保存到此檔。路徑相對於 TOML 檔案。
- `sequence.example.json`：版本化串接範例。實際播放與 UI 儲存只使用 `render.sequence` 指向的一份 `sequence.json`，不進版控；若檔案不存在，後端首次啟動會以目前 preset 建立單段串接。若想以範例串接啟動，先複製範例為 `sequence.json`。檔案中的每段含 EffectPreset、播放次數或時間、轉場（`cut`、`fade-black`、`crossfade`，或逐台淡出的 `unit-fade-black`，v0.1.6 以前的後端不接受）；根層 `ending` 可選維持最後畫面、循環播放或指定秒數淡出至黑。舊檔若沒有 `ending`，會依維持最後畫面讀取。前後端透過同一個 API 存取，瀏覽器不直接讀寫 Raspberry Pi 檔案。
- `unit_id`／`unit_count` 影響部分效果的燈組時序；要與前端畫面一致，需填入相同的值。目前固定每組 156 個邏輯像素。

舊的 `config.live.json` 若存在，只是未使用的本機備份；新程式不會讀取它。

## Windows／Pi 啟動

在 repository 根目錄：

```powershell
uv sync --locked --project backend
uv run --locked --project backend python backend/run.py --check
uv run --locked --project backend python backend/run.py
```

最後一行會持續輸出並同時啟動頁面與 API，按 `Ctrl+C` 停止。尚未連接 Art-Net 設備、只想在 UI 編輯與儲存串接時，可改用 `uv run --locked --project backend python backend/run.py --api-only`；此模式提供相同的讀寫 API，但不發送 Art-Net。短時間測試可加 `--seconds 10`；其他位置的設定檔可用 `--config PATH_TO_CONFIG.toml`。啟動後不需 WLED API；接收端本身須已設定 Art-Net。`stupidArtnet` 的 `send()` 不提供接收確認，顯示結果仍需實機檢查。

前端開發伺服器的 `/api` 會代理到 `127.0.0.1:8765`。正式使用前先在 `frontend/` 執行 `npm run build`，後端會自動提供 `frontend/dist`；若兩者不在同一份 repository 目錄下，以 `--frontend-dir /opt/moon-observe/frontend/dist` 指定建置檔位置。相機、骨架與場景設定只影響前端；FPS/RPM 仍由 TOML 管理。

## Raspberry Pi 資料位置

部署後可將程式與 `config.toml` 放在不同位置。建議唯一可寫的串接檔放在 `/var/lib/moon-observe/sequence.json`，不放在前端靜態檔或唯讀程式目錄。於 Pi 的 TOML 設定絕對路徑：

```toml
[render]
preset = "/var/lib/moon-observe/preset.json"
sequence = "/var/lib/moon-observe/sequence.json"
fps = 40
rpm = 360
pixels = 156
unit_id = 1
unit_count = 9
```

部署前建立 `/var/lib/moon-observe`，並讓執行後端的 service 使用者擁有該目錄與 JSON 檔的寫入權限。可將 `sequence.example.json` 複製到該路徑作為初始檔；後續 UI 的「儲存串接」會原子覆寫同一份檔案。`--check` 若檔案已存在會驗證格式，不啟動 Art-Net 輸出。

## 現場跨設備使用

將建置後的 `frontend/dist` 放在 Raspberry Pi 並啟動後端後，用同一個網址 `http://<Pi-IP>:8765/` 開啟頁面。頁面固定呼叫同源的 `/api/sequence`、`/api/state` 等路徑，不需填寫 API 位址或 token，也不需設定 CORS。後端預設監聽 `0.0.0.0`；若只想讓本機存取，可加 `--api-host 127.0.0.1`。Pi 的防火牆需允許現場設備連入 TCP 8765。

此設計沒有 API 驗證。能連到現場區網與該埠的設備就能讀寫串接、套用效果及送出馬達命令，因此應只在受信任的現場網路提供服務。

## 測試

```powershell
cd backend
uv run --locked python -m unittest discover -s tests -v
```

測試包含從 frontend 產生的 golden vectors、TOML/JSON 載入、排程及本機 Art-Net UDP 接收。`docs/` 內的 P0–P4 規劃文件是歷史設計，不代表現在的程式入口或功能。

## 天氣驅動九組效果

在 `config.toml` 加入場地座標；此功能預設關閉，不需要另外安裝 Python 套件。後端每 15 分鐘於背景向 [Open-Meteo Forecast API](https://open-meteo.com/en/docs) 讀取 `current.temperature_2m` 和 `current.weather_code`，不阻塞 Art-Net 影格。請求帶 `timezone=auto`，因此 `/api/weather` 的 `observedAt` 是座標所在地的當地時間（無時區後綴）；`updatedAt` 仍為 UTC。填入**實際裝置位置**：

```toml
[weather]
latitude = 25.0330
longitude = 121.5654
interval_minutes = 15
cloud_step = 6 # 允許 4–8；每 unit 增加的效果影格
```

晴天（代碼 0、1）效果影格完全同相；多雲／霧（2、3、45、48）使用 `cloud_step`；毛毛雨、雨、雪、陣雨與雷雨歸在「降水」類：**效果改用趨近線條的雨天版本**（`effects.RAIN_LINES`，固定常數）——逐月、逆向聚潮、色彩吐納只亮同心條紋（由外圈往圓心每 6 顆亮 1 顆）；中心擴散、流光波只留波峰細環；寬幅同心環每條寬帶只留內外兩條邊線；全亮與星塵雲改由雨絲組成（每顆 LED 每 2 影格依機率亮一次，旋轉時畫出短弧）；漸層彗尾的彗頭是細環、尾巴是越往後越稀疏的雨絲；隨機填滿已點亮的燈改閃雨絲。其他效果雨天不變。v0.1.11 的整台閃爍與 v0.1.10（含）以前的各 unit 隨機延遲啟動都已取代；`startPhases` 欄位保留給舊前端，一律為 0。以整台為單位的 `unit-chase`（逐台巡行）、`unit-random`（隨機單台）、`roulette-ring`（輪盤收束）九台共用同一個時間表，不套用多雲錯開與雨天線條（顏色仍照色盤），也不接受 `unitVariation`；v0.1.9（含）以前的後端不認得這三個效果。代碼分類只控制效果時間，不同步實體馬達角度；`random-leds` 等原本依 unit 產生圖案的效果也不會變成完全相同。溫度依天氣色盤分段套用漸層（預設低於 18°C、18–27°C、28°C 以上依序為冷色、中性色與暖色雙色徑向漸層），運行時覆蓋畫面色盤，不改寫 preset／sequence JSON。色盤只提供顏色：漸層效果保留自己的漸層方向（含中途切換），純色效果使用色盤的方向。效果的 `color` 加上 `"weatherPalette": false`（前端「色彩」分頁取消「套用天氣色盤」）時，該效果或串接段落改用自己的顏色，天氣的時間效果照常；省略即套用色盤。效果也可加選填的 `"unitVariation": {"parameter": "speedHz", "from": 0.2, "to": 1, "distribution": "linear"}`（前端效果分頁「各燈台不同數值」），讓九台的某個參數各取固定值：`linear` 依 unit 順序、`skip` 跳著排、`random` 固定種子隨機，值會對齊參數刻度；以次數播放時取最慢一台的週期，各台依自己的週期循環。v0.1.6 以前的後端不接受含此欄位的 preset。漸層顏色可加選填的 `"axisChange": {"to": "radius", "atSeconds": 4, "blendSeconds": 1, "repeat": false}`（前端色彩分頁「中途切換方向」）：從效果開始播放（串接時從該段開始）第 `atSeconds` 秒起，以 `blendSeconds` 秒漸變到 `to` 方向，九台同時切換；`repeat` 為 true 時兩個方向來回交替，各停留 `atSeconds` 秒。秒數 0–3600。v0.1.6 以前的後端同樣不接受。天氣類別改變時播放從頭開始；只有溫度變化時持續播放。API 更新失敗會保留上一筆有效天氣，`GET /api/weather` 提供分類、氣溫、資料時間與錯誤狀態；沒有啟用時回傳 `{"enabled":false}`。

測試不同天氣時可用手動覆寫（僅在已設定 `[weather]` 時提供，否則回 404）：`PUT /api/weather/override` 傳入 `{"category":"rain","temperatureC":30}`（`clear`／`cloudy`／`rain`，氣溫 -100–70），**直接影響實機輸出**，10 分鐘後自動切回真實天氣；`DELETE /api/weather/override` 立即切回。每次套用都重新計時並從頭播放；切回時只有生效分類改變才重播。覆寫只存在記憶體，後端重啟即清除；期間背景仍照常讀取真實天氣。`GET /api/weather` 的 `override`（含 `remainingSeconds`）與 `real` 欄位分別顯示手動值與真實天氣。

### 整點造訪其他地點

在 `[weather]` 下列出 `[[weather.visits]]`（最多 24 個，每個需 `name`、`latitude`、`longitude`），後端會在每個整點（依 Pi 系統時間，需已網路校時且時區為 Asia/Taipei）準時造訪下一個地點，依清單順序輪流：

```toml
[[weather.visits]]
name = "東京"
latitude = 35.6762
longitude = 139.6503

[[weather.visits]]
name = "倫敦"
latitude = 51.5072
longitude = -0.1276
```

整點那一格就把色盤換成造訪地點的氣溫，播放不中斷、不重播；天氣分類的效果（多雲錯開、雨天線條）等串接的下一段開始時才套用（單一效果為下一個效果週期，無週期效果為 60 秒；以維持或淡出結束的串接播完後則立即套用），套用時不重播。造訪持續播放一輪的時間（串接為整個串接長度，單一效果為至少 60 秒的整數個效果週期），之後色盤立即換回當地，時間效果同樣等下一段。造訪期間當地天氣照常更新但不重播；下一個整點到時若仍在造訪，直接換下一個地點。背景除了每次輪詢，也會在每小時 58 分預先讀取下一個造訪地點與尚未取得資料的地點；讀取失敗時沿用該地點上一筆資料，從未取得資料的地點會被略過、改造訪下一個有資料的地點。整點時若手動測試天氣進行中，跳過這個整點（輪替不前進）。`GET /api/weather` 的 `source`（`local`／`visit`／`override`）、`visit`（造訪中的地點與天氣）、`visits`（下一個地點 `next`、地點數 `count`）與 `categoryPending`（時間效果是否等待下一段套用）顯示目前狀態；前端「天氣」分頁會顯示。v0.1.7（含）以前的後端是等這一輪播完才造訪，並以 `visits.pending` 表示待開始。

測試時可用 `PUT /api/weather/visit` 傳入 `{"index":0}`（清單索引）立即造訪該地點：當場重新讀取該地點天氣（失敗時沿用上一筆，從未取得則回 422），行為與整點造訪相同（色盤立即換上、不重播，時間效果等下一段；一輪的時間後回到當地），不改變整點輪替順序；`DELETE /api/weather/visit` 提前結束造訪，同樣色盤立即換回、不重播。手動測試天氣進行中時無法造訪（422）。前端「天氣」分頁的「立即造訪」「結束造訪」按鈕即呼叫這兩個 API。

天氣色盤可在 `http://<Pi-IP>:8765/palette.html` 編輯（主頁天氣區塊有連結）：1–12 段，每段設定氣溫上限與 2–8 個色點，最後一段涵蓋以上所有氣溫，漸層方向全段共用（只用於純色效果；漸層效果照各自的方向）。資料存於 `[weather] palette` 指定的 JSON（預設為 TOML 同目錄的 `palette.json`，不進版控）；檔案不存在時使用內建三段。`GET /api/weather/palette` 讀取、`PUT /api/weather/palette` 驗證後原子覆寫，下一個影格即生效、不重播；未設定 `[weather]` 時回 404。多人同時編輯時以最後儲存者為準。頁面的「在實機預覽此段」會以該段內的氣溫送出 10 分鐘的手動測試天氣，須先儲存才會使用新色盤。

單組舊設定仍可使用。若九組都由同一台 Pi 輸出，請刪掉 `[artnet]` 裡的 `ip`／`universe`，改用九筆 `[[artnet.targets]]`；每筆的 unit ID 和 IP/universe 組合必須唯一。例如：

```toml
[artnet]
[[artnet.targets]]
unit_id = 1
ip = "192.0.2.51"
universe = 0

[[artnet.targets]]
unit_id = 2
ip = "192.0.2.52"
universe = 0

# 依實際控制器補上 unit_id = 3 至 9，各自的 ip/universe。

[render]
preset = "preset.json"
sequence = "sequence.json"
fps = 40
rpm = 360
pixels = 156
unit_count = 9

[weather]
latitude = 25.0330
longitude = 121.5654
```

先執行 `uv run --locked --project backend python backend/run.py --check --config backend/config.toml` 驗證設定。九組共用一個播放迴圈與天氣快照，每影格送出九包 Art-Net。前端每 5 秒讀取同源的 `/api/weather`，用同一組延遲與色盤預覽；介面中的手動 Effect frame step 在取得有效天氣後會停用。
