# moon_observe_re 實作計畫（定稿草案）

> 2026-11-02。目標：在 LongN 的硬體（5 台旋轉半圓燈）上執行 Moon Observe 系統。
> 系統部分（effect engine、串接、天氣、API、前端、設定檔）沿用 `system-reference.md`；
> 從 LongN 只保留「LED 排列」與「馬達控制」；部署平台改為 **Windows**。

## 0. 已確認的決策

| # | 決策 |
|---|---|
| 1 | 把 `~/Dev/moon_observe` 的 `backend/` 與 `frontend/` 複製到本 repo 再修改，兩邊互不影響 |
| 2 | effect engine 直接算 152 顆，每顆獨立，不做鏡像 |
| 3 | 馬達只透過 API 手動控制（每台的速度、方向），不放進串接 |
| 4 | 保留月亮校正，可以啟用或關閉 |
| 5 | 前端一起改成 5 台 × 152 顆，加入每台的馬達 UI |
| 6 | 部署改為 Windows，取代 Pi 的 systemd 流程 |
| 7 | GitHub repo：`whyixd/moon_observe_re`（public、目前是空的），release 從這裡發布 |
| 8 | 現場是 Windows 10、可以上網；Art-Net 走有線 Ethernet，網際網路走 Wi-Fi |
| 9 | 馬達 rpm = 500（max）；其他現場數值先用預設值 |
| 10 | 不做 Art-Net 失聯保護（控制盒收不到資料時不會自己停，目前先不處理） |

以下為我先採用的預設，可以再調整：
- 馬達速度用三段等級 `stop / mid / max`，對應的 byte 值寫在 config（預設 0 / 60 / 230，與 LongN 相同）。
- 月亮校正：config 決定開機時的預設，前端可以即時切換（只存在記憶體）；只在該台馬達為 `max` 時套用，與 LongN 相同。
- 程式結束時，對每台每個 universe 送全 0 的 512 bytes（LED 全暗、馬達停止）兩次，與 LongN 相同。

## 1. 從 LongN 保留的硬體規格

### 1.1 LED 排列
- 5 台，IP `2.0.0.101`–`2.0.0.105`，subnet 0。
- 每台把同一份 512 bytes 同時送到 universe 0 和 universe 1（控制盒的 U0 走 DMX → 馬達，U1 走 SPI → LED）。
- 每台 152 顆：index 0 是一腳，75/76 是頂點，151 是另一腳（從 `TransLight.pde` 推斷，**需要現場確認**）。
- 色序 GRB，`brightness` 預設 0.4。
- LongN 的 `IP.ini` 是 `2.20.18.9`，但現場電腦的 Ethernet 實際設定是 `2.0.0.99/24`（2026-11-03 透過 SSH 確認），`artnet.source_ip` 用 `2.0.0.99`。

### 1.2 Payload（每台 512 bytes）

| Channel（從 1 起算） | 內容 |
|---|---|
| 1–456 | 152 × (G, R, B)，算法為 `floor(clamp01(c × 校正 × brightness) × 255 + 0.5)` |
| 457 | 馬達速度：`stop`=0、`mid`=60、`max`=230 |
| 458 | 方向：`cw`=0、`ccw`=255 |
| 459–512 | 0 |

### 1.3 月亮校正（以半圓位置計算，兩邊對稱）
- `h = p`（p < 76）或 `151 - p`（p ≥ 76）；h=0 是腳，h=75 是頂點。
- 靠腳的 15 顆（h < 15）：係數 = `(h + 1) / 15`。
- 靠頂點的 7 顆（h ≥ 69）：係數 = `0.3 + 0.1 × (75 - h)`。
- 只在 `moon_correction` 啟用、且該台速度為 `max` 時套用。

## 2. 專案結構

```
moon_observe_re/
  LongN/                         # 原專案，只留作對照，不修改
  PLAN.md                        # 本文件
  system-reference.md            # 完成後改寫成本系統的版本
  backend/                       # 從 moon_observe/backend 複製
    pyproject.toml               # py3.12、stupidartnet==1.6.0、package=false（照原樣）
    config.example.toml          # 改成 5 個 targets、[hardware]、[motor]
    moon_observe_backend/
      hardware.py   [新增]       # 月亮校正、GRB、亮度、組 512 bytes payload
      motor.py      [新增]       # MotorStore：每台的 speed／direction，只存在記憶體，重啟後一律 stop
      config.py     [修改]       # pixels 可設定（預設 152）、targets.universes、[hardware]、[motor]
      output.py     [修改]       # 改用 hardware.build_payload；每個 (target, universe) 一個 StupidArtnet；新的結束流程
      control.py    [修改]       # /api/motor 新格式、/api/hardware、state 回傳硬體資訊
      renderer.py   [小改]       # world-upper-half 的相位估計改用每台的 rpm 與方向
      effects.py    [小改]       # litCount／darkGap 上限改為依 led_count；效果邏輯不動
      sequence.py / palette.py / weather.py / playback.py / unit_colors.py   # 照原樣
    tests/                       # 原有測試保留，另加 test_hardware.py、test_motor.py、payload golden test
    deploy/                      # 改寫為 Windows 版（第 5 節）
  frontend/                      # 從 moon_observe/frontend 複製（第 4 節）
```

## 3. 設定檔與 API

### 3.1 `config.toml`

```toml
[artnet]
source_ip = "2.0.0.99"           # 選填：綁定 Art-Net 網卡（現場電腦的 Ethernet）

[[artnet.targets]]
unit_id = 1
ip = "2.0.0.101"
universes = [0, 1]               # 新欄位；保留原本的 universe = n 寫法
# … unit 2–5

[render]
preset = "preset.json"
sequence = "sequence.json"
fps = 40
pixels = 152                     # 改為 1..512/3 的範圍檢查，不再鎖定 156
unit_count = 5

[hardware]                       # 新增
color_order = "GRB"              # RGB / GRB / BRG …
brightness = 0.4                 # 0..1
moon_correction = true           # 開機時的預設

[motor]                          # 新增
speed_channel = 457
direction_channel = 458
speeds = { stop = 0, mid = 60, max = 230 }
directions = { cw = 0, ccw = 255 }
rpm = { mid = 130, max = 500 }   # max 為使用者提供；mid 依 60/230 比例估計，之後可改；只用於模擬器與相位估計

[weather]                        # 照原樣，選填
```

實作時定下的細節（M2）：
- `[render].rpm` 已移除，寫了會報 unknown field。rpm 改放 `[motor].rpm`；`config["rpm"]` 暫時等於 `rpm.max`，供現有的相位估計和前端讀取，M5／M6 再改成每台各自的轉速。
- `[hardware]`、`[motor]` 整段或個別欄位都可以省略，省略時用 LongN 的預設值；`render.pixels` 預設 152、`unit_count` 預設 5。
- target 的 `universe` 和 `universes` 必須寫其中一個，不能同時寫；載入後一律只有 `universes`（M5 已移除相容用的 `universe`，config 頂層的 `ip`／`universe`／`unit_id` 也一併移除）。

驗證規則照參考系統的嚴格程度：
- 有多餘欄位就報錯。
- 兩個 channel 不可重疊，也不可落在 LED 的範圍內。
- `(ip, universe)` 不可重複。

### 3.2 API 變更（其餘照 `system-reference.md` §3.2）

| Method | Path | 變更 |
|---|---|---|
| GET | `/api/state` | `motor` 改為 `{channels:{speed,direction}, levels, units:[{unitId, speed, direction, value, directionValue}]}`；新增 `hardware:{colorOrder, brightness, moonCorrection, pixels}` |
| PUT | `/api/motor` | `{"unitIds":[1,2]?, "speed":"stop"\|"mid"\|"max"?, "direction":"cw"\|"ccw"?}`；省略 `unitIds` 就是全部；只存在記憶體 |
| PUT | `/api/hardware` | `{"moonCorrection": bool}`；只存在記憶體，重啟後回到 config 的預設 |

`GET /api/playback` 另外附上每台目前的馬達狀態，讓前端模擬器可以照著轉。

實作時定下的細節（M3）：
- `motor.py` 有 `MotorStore`（每台的 speed／direction）和 `HardwareStore`（月亮校正開關），兩者都只存在記憶體；重啟後馬達一律 `stop`、方向回到 `cw`，月亮校正回到 config 的 `moon_correction`。
- `/api/motor` 至少要給 `speed` 或 `direction` 其中一個，沒給的欄位維持原值；`unitIds` 必須是不重複的 1..`unit_count` 整數。舊的 `{"enabled": bool}` 會回 422。上限 256 bytes，`/api/hardware` 上限 64 bytes。
- `/api/motor`、`/api/hardware`、`/api/preset` 都回傳完整的 `/api/state`。`state.motor` 另外有自己的 `revision`、`levels.rpm`，每台多一個 `rpm`（stop 為 0）；`state.hardware` 多一個 `moonCorrectionDefault`。頂層的 `revision` 現在只計算 preset 的變更。
- `/api/playback` 在 `active` 時附上 `motor: [{speed, direction}, …]`（依 unitId 排列）。
- 前端的馬達按鈕還是送舊格式，會收到 422，M6 改。

實作時定下的細節（M5）：
- `output.py` 每個 (target, universe) 開一個 StupidArtnet client，封包 512 bytes；同一台的每個 universe 送同一包（`hardware.build_payload`）。
- 每格讀一次 `MotorStore.snapshot()` 和 `HardwareStore.moon_correction()`，API 的變更從下一格生效。
- 相位估計改成每台各自累加：依該台目前速度的 rpm（stop 為 0，ccw 為負）每格前進，所以停止的台相位不動，只有 `world-upper-half` 會用到。`config["rpm"]`（= `rpm.max`）只剩 API 狀態還在回報，M6 前端改完後再決定是否移除。
- 結束流程：不論正常結束、Ctrl+C 或例外，每個 universe 都送兩次全 0（燈全暗、馬達停），然後關閉 client。
- `/api/state` 的 `output` 改成 `{fps, rpm, pixels, unitCount, sourceIp, targets:[{unitId, ip, universes}]}`；前端連線狀態那行還在讀舊的 `ip`／`universe`，M6 改。
- 測試共用的設定放在 `tests/support.py`：`reference_config()` 是參考系統的 156 顆 × 9 台（RGB、全亮、無月亮校正、馬達移到 ch469／470，所以像素位元組和原本的測試一樣），`longn_config()` 是 LongN 現場設定。

## 4. 前端修改

- `preview3d/geometry.ts`：`LEDS_PER_ARC` 改從後端的 `output.pixels` 取得（離線預設 152）。
- `simulation/model.ts`：1×9 圓弧改成可設定的 5 台排列，先用 LongN `Simulation.pde:calcMotorPosition` 的排列，**需要現場確認**。視角選項改成〔單組｜全部〕，unit 選擇器依 `unitCount` 產生。
- 模擬器的轉速：每台依各自的 speed 等級 → rpm 和方向旋轉。後端控制模式下照後端狀態；模擬模式下用本地狀態。
- ControlPanel「後端」分頁的馬達區：
  - 每台一列：〔停｜中｜全速〕〔順｜逆〕。
  - 加上「全部」列，以及月亮校正開關。
- 「物理」分頁：Motor speed 改成 mid / max 兩個 rpm（連上後端時由後端鎖定）。
- effects 中依 156 寫死的參數上限（`periodicLeds.ts`、`randomLeds.ts`）改為依 ledCount。

實作時定下的細節（M4）：
- 參數表上的固定上限改成 170（一個 universe 放得下的燈數），實際上限另外依燈數計算：`litCount` ≤ 燈數，`darkGap` ≤ 燈數 − 1。前端 `parameterMax()`（`effects/index.ts`）和後端 `parameter_max()`（`effects.py`）共用同一張 `LED_COUNT_BOUNDS` 表；`unitVariation` 的 from／to 也套用同樣的上限。
- 前端的參數滑桿和「各燈台不同數值」的滑桿都改用依燈數的上限。目前前端的燈數仍是 156，M6 改成從後端讀取。
- `effects_v2.json` 原本 156 顆 × 9 台的內容完全不變；另外新增 `longn` 區塊（152 顆 × 5 台）：全部 preset 加 4 個貼著上限的 preset 的整條畫面雜湊（1008 組）、各燈台不同數值（54 組）、整台效果（6 組）、雨天線條（20 組）。
- 後端函式的 `led_count`／`pixels` 參數預設值仍是 156，實際執行時一律由 config 傳入，沒有影響。
- `generateBackendVectors.ts` 加產生一份 152 顆的測試資料，前後端都要比對。

實作時定下的細節（M6）：
- 燈數、台數、mid／max rpm 都從後端讀取（`/api/sequence` 與 `/api/state` 的 `output` 有 `pixels`、`unitCount`、`motorRpm`），離線預設 152 顆 × 5 台、130／500 rpm。`config["rpm"]` 與 API 的 `output.rpm` 已移除。
- 「全部」視角的排列是 LongN `calcMotorPosition` 推廣到 N 台：Processing（X 右、Y 朝觀眾、Z 上，初始相機 `rotateX(PI/2)`）換成 three.js（x、y 上、z 朝觀眾），各台頂點方向 = `rotateZ(Angle)`，比例照 LongN 的 LED_RADIUS 35 對 X 間距 297.5。5 台的頂點依序朝左、左後、右後、右前、正前，看起來是一組月相。**需要現場確認**。
- 每台照自己的 speed／direction 轉，改變轉速時角度連續（`RotorSegment`）。模擬模式預設全速順轉、可在「物理」分頁逐台調整；後端控制時照 `/api/playback` 的 `motor`（沒有在播放時用 `/api/state`）。
- `world-upper-half` 的相位估計改用輸出影格起點的轉角加上未知相位，和後端 M5 每台累加的做法一致。
- 月亮校正在模擬器也套用（`src/hardware.ts`，數值與後端相同、有測試），只在該台全速且開關打開時生效；亮度 40% 不模擬。
- 馬達面板（`MotorPanel`）：「全部」一列加每台一列〔停｜中速｜全速〕〔順｜逆〕，後端模式顯示實際送出的 DMX 值與 channel，另有月亮校正開關。
- M7 要注意：在背景（非互動 shell）啟動時 SIGINT 會被忽略，Python 收不到 Ctrl+C、結束時不會送全 0；Windows 服務停止時送的 Ctrl+C 也可能因 process group 收不到。（M7 已處理，見下方 M7 細節。）

## 5. Windows 部署（取代 Pi 的 systemd）

沿用「版本化、不可變 release」的原則，只是換成 Windows 的機制：

| 用途 | Pi（參考） | Windows（本專案） |
|---|---|---|
| 程式位置 | `/opt/moon-observe/releases/<v>`、`current` symlink | `C:\MoonObserve\releases\<v>`、`current` junction（停止服務後切換，失敗就回退） |
| 設定與可寫資料 | `/etc/moon-observe/{config.toml, preset/}` | `C:\ProgramData\MoonObserve\{config.toml, preset\, logs\}` |
| 服務 | systemd unit | **WinSW**（固定版本並驗證 SHA-256）；`Automatic (Delayed Start)`；失敗時自動重啟 |
| 執行帳號 | system user `moon-observe` | `NT AUTHORITY\LocalService`；ACL 只允許寫入 `preset\` 和 `logs\` |
| 正常停止 | `KillSignal=SIGINT` | WinSW 停止時送 Ctrl+C → KeyboardInterrupt → 關燈、馬達停止（**需要實測確認**） |
| Log | journald | WinSW 的 log 檔，依大小輪替 |
| 安裝腳本 | `bootstrap.sh`、`install-release.sh` | `bootstrap.ps1`、`install-release.ps1`、`uninstall.ps1` |
| Artifact | `tar.gz` | `zip`（含 backend、前端 dist、WinSW）+ `SHA256SUMS` |

`install-release.ps1` 的流程：
1. 取得 artifact：從 GitHub Release 下載，或用 `-ArtifactPath` 指定本機 zip（現場沒網路時用）。
2. 驗證 SHA-256 → 解壓。
3. 執行 `uv sync --frozen`，Python 由 uv 管理，放在 `C:\MoonObserve\.uv-python`。
4. 用新版執行 `run.py --check`，驗證現有設定。
5. 停止服務 → 切換 junction → 啟動服務。
6. 健康檢查：`/api/state` 和 `/` 都要回應，3 秒後仍正常。
7. 失敗就自動切回前一版；成功後保留最近 3 版。

Windows 10 相容性：
- 腳本以系統內建的 **Windows PowerShell 5.1** 為準，不使用 PowerShell 7 才有的語法（`??`、三元運算子、`ForEach-Object -Parallel`）。
- 下載前強制啟用 TLS 1.2；`Invoke-WebRequest` 加上 `-UseBasicParsing`。
- junction 用 `New-Item -ItemType Junction`，不需要開發人員模式。
- repo 是 public，下載 release **不需要 GitHub token**；`bootstrap.ps1` 保留「選填 token」以備日後改成 private。

網路（Art-Net 走 Ethernet、網際網路走 Wi-Fi）：
- Ethernet：固定 IP `2.0.0.99/24`（現場電腦原本就這樣設定），**不設預設閘道**，避免搶走 Wi-Fi 的對外路由；`2.0.0.0/24` 的路由自然走 Ethernet。
- `config.toml` 設 `artnet.source_ip = "2.0.0.99"`，把 Art-Net 綁在 Ethernet 送出；網路線沒插時也不會改走 Wi-Fi 送到公網的 2.0.0.x。
- Wi-Fi：DHCP，負責天氣（Open-Meteo）、GitHub 下載和校時。
- 防火牆：允許 TCP 8765 inbound，供同一 Wi-Fi 的裝置開控制頁。沒有閘道的 Ethernet 會被判定為「未識別的網路／公用」，規則只開在 Wi-Fi 所屬的設定檔（Private），避免把 API 暴露到 Art-Net 網段以外。
- README 加入網卡檢查：Ethernet 有 `2.0.0.99`、能 ping 到 `2.0.0.101`–`105`。
- 電源：關閉睡眠和硬碟休眠。
- Windows Update：設定使用時段。重開機後服務會自動啟動，不需要登入（比 LongN 原本的 `.bat` 加 `.exe` 更穩）。
- 時區設為 Asia/Taipei（天氣整點造訪會用到）。

實作時定下的細節（M7）：
- 檔案：`backend/deploy/{bootstrap.ps1, install-release.ps1, uninstall.ps1, moon-observe.xml, build_release.py, README.md}`；Pi 的 `.sh`／`.service` 已刪除。操作步驟與現場驗收清單在 `backend/deploy/README.md`。
- Artifact：`moon-observe-<版本>-windows.zip`（頂層資料夾 `moon-observe-<版本>/`）+ `SHA256SUMS`；同一個 tag 重建逐 byte 相同。GitHub Release 另外附上 `bootstrap.ps1`。
- WinSW 用 2.12.0 的 `WinSW.NET461.exe`（Windows 10 內建 .NET 4.8），SHA-256 固定在 `build_release.py`；GitHub 沒有公布官方雜湊，值是 2026-11-03 下載時記下的。uv 固定 0.12.23，雜湊取自官方 `.sha256`，寫死在 `bootstrap.ps1`。
- 服務帳號用 `Win32_Service.Change` 設成 LocalService、延遲自動啟動用 `sc.exe config start= delayed-auto`，不靠 WinSW 2.x 寫法不一的 XML 欄位。WinSW 放在 `C:\MoonObserve\service\`（每次啟用時從 release 複製），XML 由範本代入路徑與 port。
- 權限用 well-known SID 設定（不受 Windows 顯示語言影響）：程式資料夾只有 Administrators 可寫；`C:\ProgramData\MoonObserve` 只有 `preset\`、`logs\` 讓 LocalService 寫入；token 檔只有 Administrators。
- 停止：新增 `moon_observe_backend/stopping.py`，把 SIGINT、SIGTERM、SIGBREAK 都轉成一次 KeyboardInterrupt（第二次起忽略，不會打斷送全 0），繼承來的「忽略 SIGINT」也會被蓋掉；Windows 上另外呼叫 `SetConsoleCtrlHandler(None, False)` 重新打開 Ctrl+C。`tests/test_stopping.py` 實際啟動後端，用 SIGTERM 與「繼承忽略的 SIGINT」停止，確認收到全 0。
- 驗證（開發機）：`.ps1` 只做靜態測試（ASCII、無 BOM、版本 regex 一致且區分大小寫、沒有 PowerShell 7 語法、`-UseBasicParsing`、範本佔位字串與 XML 格式）；想在 Mac 上下載免安裝 PowerShell 做語法檢查，被權限規則擋下，沒有執行。另在暫存資料夾的臨時 tag 上實際建置 zip、重建比對雜湊，並用解壓後的 release `uv sync` + `run.py --check` 通過。

現場電腦實測（M7，2026-11-03，透過 SSH 金鑰登入 `desktop-9n17278\define moon`）：
- 電腦狀態：Windows 10 22H2（19045）、.NET 4.8.1、PowerShell 5.1；Ethernet（Realtek，中文名稱「乙太網路」）已設 `2.0.0.99/24`，當時沒插網路線；Wi-Fi `192.168.1.52`（私人網路）。時區原本是中歐時間，依指示改成 Taipei Standard Time。桌面有舊的 LongN，但沒有設定自動啟動。
- 測試方式：在暫存的 clone 上打 `v0.2.0-rc.1`（正常）、`rc.2`（同內容）、`rc.3`（設定檢查會過、但一啟動就結束）三個 tag 建 zip（不 push、不發 Release），scp 過去用 `-ArtifactPath` 安裝。測試用的 config 把 Art-Net 全部送到 127.0.0.1（網路線沒插時送 2.0.0.x 會經 Wi-Fi 跑到公網）。
- 結果：首次安裝（uv 0.12.23、CPython 3.12.15）、服務帳號 LocalService + 延遲自動啟動、ACL、防火牆（從 Mac 經 Wi-Fi 打得開控制頁）都正確。`Stop-Service` 0.3 秒完成，10 個 universe 最後都收到兩包全 0（停止前馬達為 230／255），log 最後是 `Stopped.`，WinSW 記錄 exit code 0；venv 的 `python.exe` 是啟動器、真正的 Python 是子程序，Ctrl+C 一樣送得到。升級 rc.1 → rc.2 10 秒、健康檢查通過；不帶 zip 回退到 rc.1 成功。
- **找到並修正的 bug**：壞掉的版本一啟動就結束時 `Start-Service` 會丟例外，直接跳到最外層 catch，沒有回退，`current` 停在壞版本、服務停止。修正後啟動失敗視為不健康，切換之後的任何例外都會回退；用修正版重測，rc.3 自動回退到 rc.1 成功（exit code 1）。`test_release.py` 加了回歸測試。rc.1／rc.2 裡的 installer 還是舊版，下一個正式版本才會帶修正。
- 測完狀態：服務停止（開機仍會自動啟動，config 只送 127.0.0.1）、`current` → rc.1，保留 rc.1、rc.2，刪除 rc.3。

## 6. 里程碑與驗證

| # | 內容 | 完成條件 |
|---|---|---|
| M1 ✅ | 複製 backend、frontend，在 macOS 上 `uv sync --locked` | 原有 backend 與 frontend 測試全部通過（2026-11-02：來源 `moon_observe@b736485`（v0.1.12+1）以 `git archive` 匯出；backend 86、frontend 117 個測試通過；`tsc` + build 通過；`npx vite-node scripts/generateBackendVectors.ts` 重新產生的 fixture 與原檔逐 byte 相同） |
| M2 ✅ | `config.py` + `hardware.py` + golden test | payload 的 channel 排列逐 byte 符合 `Artnet.pde`；月亮校正數值符合 1.3 節（2026-11-02：brightness 1.0 時與 LongN 移植版逐 byte 相同；brightness 0.4 加月亮校正時每個 channel 只會比 LongN 亮 0 或 1，因為 LongN 是先四捨五入再整數截斷，這裡是浮點數運算後只捨入一次；backend 共 102 個測試通過） |
| M3 ✅ | `motor.py` + `/api/motor` + `/api/hardware` | API 測試：422/415/413 規則、只存在記憶體、重啟後一律 stop（2026-11-02：新增 `test_motor.py` 14 個測試，backend 共 116 個測試通過；實際啟動 `--api-only` 用 curl 測過 state／motor／hardware） |
| M4 ✅ | effects 改為 152 顆 + 重新產生測試資料 | 所有效果在 152 / 156 顆下前後端都一致（2026-11-02：見下方 M4 細節；前端 118、backend 124 個測試通過） |
| M5 ✅ | 整合 `output.py`、結束流程 | `--api-only` 正常；用本機 UDP listener 驗證 10 個封包、結束時送全 0（2026-11-03：`test_send.py` 用真的 StupidArtnet 對本機 listener 收到 5 格 × 2 universe = 10 包，接著每個 universe 兩包全 0；另外實際啟動 `run.py`，用 API 切換馬達與月亮校正、Ctrl+C 結束，封包內容都正確；backend 共 127 個測試通過） |
| M6 ✅ | 前端 | `npm test`、`tsc` 通過；用 Playwright 截圖確認 5 台的畫面和馬達 UI（2026-11-03：前端 124、backend 127 個測試通過；用 Playwright 控制本機 Chrome 實際操作模擬模式與後端控制模式，馬達、月亮校正、相機取景都確認過） |
| M7 🟡 | Windows 部署腳本 | 在 Windows 機器上完成：安裝 → 升級 → 回退 → 停止時馬達確實停下（2026-11-03：透過 SSH 在現場電腦 DESKTOP-9N17278（Windows 10 22H2、PowerShell 5.1）用 rc 測試版完成首次安裝、升級、手動回退、自動回退與停止測試，細節見下方；**還沒做**：接上控制器看燈與馬達實際反應、重新開機後自動啟動） |
| M8 ✅ | 文件 | 改寫 `system-reference.md`、backend 與 deploy 的 README（2026-11-03：`system-reference.md` 改成 LongN 系統並新增「LongN 硬體對應」一節；重寫 `backend/README.md`、`frontend/README.md`，修正 `frontend/src/effects/README.md` 的 156／9 台／360 RPM；新增根目錄 `README.md`；`backend/docs/`、`frontend/docs/` 標明是參考系統的歷史文件） |
| M9 🟡 | 定時播放（§9） | backend／frontend 測試通過；本機短時段實跑確認馬達切換與時段外全 0；現場確認重新開機後進入正確階段（2026-11-04：backend 168、frontend 133 個測試通過；開發機實跑通過，細節見 §9.7；**還沒做**：現場確認暖機秒數與重新開機後的階段；2026-11-06 改為燈光全天、馬達對齊輪次，見 §9.8） |

## 7. Git 與 repo 內容

- 在本目錄 `git init`，remote 設為 `https://github.com/whyixd/moon_observe_re.git`，預設分支 `master`（與參考 repo 相同）。
- repo 是 **public**，以下內容**不進版控**（寫進 `.gitignore`）：
  - `LongN/data/*.mov`、`LongN/application.windows32/`、`LongN/application.windows64/`（影片約 210 MB，加上兩份 Java runtime 和 exe）
  - `config.toml`、`preset.json`、`sequence.json`、`palette.json`（與參考 repo 相同，只放 example）
  - `dist/`、`node_modules/`、`.venv/`
- LongN 只保留 `*.pde`、`data/point798.txt`、`data/IP.ini` 作為對照。

## 8. 已確認、先不處理

- 控制盒收不到 Art-Net 時不會自己停馬達，目前不做額外保護；只保留「程式正常結束時送全 0」。
- 5 台的排列位置、152 顆的接線方向（index 0 在哪一腳）先用預設值，之後到現場再調整 config 和前端排列。

## 9. 定時播放（M9）

> 2026-11-04 規劃。需求：播放一輪串接後休息 N 分鐘（可調）；休息時只停馬達、燈效繼續；可設定每日表演時段；可設定特定日期的特殊時段。

### 9.1 已確認的決策

| # | 決策 |
|---|---|
| 1 | 不在表演時段內：持續送全 0（燈全暗、馬達停）。持續送而不是停止送，因為控制盒收不到 Art-Net 不會自己停馬達（§8） |
| 2 | 表演時每台馬達的速度、方向由排程另存一組，寫在檔案裡，重新開機後照樣自動表演。排程啟用時，手動馬達面板改成唯讀；要手動測試馬達，先把排程關掉。決策 §0-3 的「馬達只透過 API 手動控制」改為「手動或排程控制，仍然不放進串接」 |
| 3 | 特殊日期取代當天的每日時段；同一天可以設多段，也可以設成「當天不表演」（例如休館日） |
| 4 | 時段結束時立刻結束：馬達馬上停，燈在 `endFadeSeconds` 內淡出，之後進入時段外 |

> **2026-11-06 改版（v0.3.0）**：燈光改為全天循環播放，排程只控制馬達；時段內不休息、沒有淡出與全暗。下面 9.1 的 #1、#4 與 9.2 是 v0.2.0 的行為，新規則見 9.8。

### 9.2 行為

```text
時段外（全 0） ──時段開始──▶ 暖機（馬達照排程設定啟動，燈維持全暗，spinUpSeconds 秒）
                                 │
                                 ▼
                             播放（串接從第 1 段開始）
                                 │ 播完一輪
                                 ▼
                             休息（馬達停，燈效繼續循環播放）
                                 │ 休息 restMinutes 分鐘
                                 ▼
                             暖機（馬達啟動，燈效繼續循環播放，spinUpSeconds 秒）
                                 └──▶ 播放（從第 1 段重新開始）……

任何階段遇到時段結束 ──▶ 結束中（馬達停、燈淡出 endFadeSeconds）──▶ 時段外
```

- 「一輪」沿用 `output.round_length`：串接是所有段落加總的長度；單一效果至少 60 秒並對齊效果週期，和天氣造訪的一輪一樣。
- 排程期間串接一律循環播放，忽略 `ending` 設定（否則休息時燈會停在最後一格或全暗）；時段結束的淡出由排程負責。
- 休息時間一到先啟動馬達，等 `spinUpSeconds`（預設 5 秒，等馬達到目標轉速）後才從第 1 段重新播放燈效，畫面會跳回開頭（切換方式沿用串接的循環轉場）。暖機期間燈效照休息時的樣子繼續播。
- 時段開始時也一樣先暖機，這段時間燈維持全暗，馬達到速後串接才從第 1 段亮起。
- 沒有回授，只能用固定秒數估計馬達到速；`spinUpSeconds` 可在控制頁調整，到現場依實際轉速修正。
- 程式在時段中途啟動（重新開機、升級、服務重啟）時，和時段開始一樣：先暖機，再從第 1 段播放。
- `restMinutes = 0` 時馬達一直在轉，播完一輪直接從第 1 段重播，不再暖機。
- 暖機的秒數不算在休息時間裡：休息 10 分鐘 + 暖機 5 秒，下一輪燈效在 10 分 5 秒後開始。
- 時間用現場電腦的本地時間（Windows 時區要設成台北），控制頁會顯示後端時間，方便發現時區設錯。
- 時段不跨午夜（`end` 最晚 `24:00`）；需要跨夜時拆成兩天設定。起點包含、終點不包含。
- 單色測試照舊可用，時段外也能用（現場測燈）。天氣與每小時造訪照常運作，不受排程影響。

### 9.3 設定檔與 API

`config.toml` 的 `[render]` 新增選填的 `schedule`（相對於 TOML）；省略時放在 `sequence.json` 同一個資料夾，現場已安裝的 config（`sequence = "preset/sequence.json"`）不用修改就會存到服務可寫的 `preset\`。檔案不存在時視為排程關閉，行為和現在一樣。`schedule.json` 不進版控，另附 `schedule.example.json`：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "restMinutes": 10,
  "spinUpSeconds": 5,
  "endFadeSeconds": 3,
  "motors": [
    {"unitId": 1, "speed": "max", "direction": "cw"}
  ],
  "daily": [{"start": "18:00", "end": "20:00"}],
  "dates": [
    {"date": "2026-11-05", "windows": [{"start": "14:00", "end": "21:00"}]},
    {"date": "2026-11-10", "windows": []}
  ]
}
```

- 驗證：`restMinutes` 0–240（0 = 不休息、連續播放）；`spinUpSeconds` 0–30；`endFadeSeconds` 0–10；`motors` 每台一筆，速度只能是 `mid`/`max`（排程不需要 `stop`）；時間格式 `HH:MM`，同一天的時段不能重疊；`dates` 不重複。過期日期保留，控制頁顯示為灰色。
- `GET /api/schedule`：設定加上目前狀態 `status`：`now`、`phase`（`off`/`spinup`/`play`/`rest`/`ending`/`disabled`）、`phaseEndsAt`、`round`、今天的時段、`nextShowAt`。
- `PUT /api/schedule`：原子寫入，存檔後立即依新設定重新判斷目前階段。
- `GET /api/playback` 一併帶 `schedule.phase`，前端照舊輪詢就能更新。
- 排程啟用時 `PUT /api/motor` 回 409，並說明要先關閉排程。

### 9.4 後端

- 新增 `schedule.py`：
  - `validate_schedule`、`ScheduleStore`（照 `SequenceStore` 的原子寫入方式）。
  - 純函式 `windows_on(document, date)`、`resolve(document, now)`：算出目前所在的時段、結束時間與下一場。
  - `Scheduler`：每一格由 `stream()` 呼叫一次，輸入現在時間、這一輪的長度、這一格的播放位置，回傳階段、馬達設定、燈的狀態（照常／淡出中／全暗），以及是否要從第 1 段重播（暖機結束那一格）。時鐘可以注入，方便測試。
- `output.stream()`：新增 `scheduler` 參數。有排程時，馬達用排程的結果，重播時重設 `playback_start_frame`，燈套用亮度倍率；時段外直接送 `blackout_payload()`。沒有排程時行為完全不變。
- `control.py`：加 `/api/schedule` 路由、body 上限、`/api/motor` 的 409。

### 9.5 前端

- 控制頁新增「排程」分頁 `SchedulePanel`：
  - 啟用開關、休息分鐘、暖機秒數、結束淡出秒數、每台馬達的速度和方向。
  - 每日時段（可多段）、特殊日期列表（日期選擇器、多段時段或「不表演」）。
  - 目前狀態，例如「表演中 · 第 3 輪播放」「休息中，18:42 開始下一輪」「暖機中，3 秒後開始」「時段外，下一場 11/5 14:00」，以及後端時間。
- 排程啟用時，`MotorPanel` 顯示排程目前給的馬達狀態，按鈕停用並提示要先關閉排程。

### 9.6 驗證

- backend 單元測試：
  - 每日時段、特殊日期取代、「不表演」、起訖邊界。
  - 狀態機（假時鐘）：開始 → 暖機（燈全暗、馬達轉）→ 播完一輪 → 休息 N 分鐘 → 暖機（馬達轉、燈繼續）→ 從第 1 段重播；暖機中遇到時段結束；播放中或休息中遇到時段結束 → 馬達停、淡出、全 0；時段中途啟動；`restMinutes = 0`；排程關閉時和現在逐 byte 相同。
  - API 驗證、409、存檔與重啟後保留。
- frontend：`SchedulePanel` 的編輯與驗證測試，`npm test`、`tsc` 通過。
- 實機：本機用短時段（例如 2 分鐘、休息 1 分鐘）跑完整一輪，用 UDP listener 確認馬達 channel 457／458 的切換和時段外全 0；現場再測一次重新開機後是否自動進入正確階段（和 M7 的開機自動啟動一起測）。
- 文件：更新 `system-reference.md`、`backend/README.md`、根目錄 `README.md`。

### 9.7 實作紀錄（2026-11-04）

- 實作照 9.1–9.5，與規劃不同或補充的地方：
  - `schedule.json` 預設和 `sequence.json` 同一個資料夾（見 9.3），避免現場舊 config 存檔失敗。
  - 相鄰時段（例如 18:00–19:00 接 19:00–20:00，或 22:00–24:00 接隔天 00:00–02:00）視為同一段連續播放，不會在交界處淡出再暖機。
  - 休息、結束中與時段外的馬達送 `stop`，方向維持排程設定，避免減速時反轉。
  - 排程啟用時 `/api/playback` 的 `motor` 改成排程實際送出的值，3D 鏡像跟著轉；手動馬達面板改為唯讀並隱藏 DMX 數值。
- 測試：`backend/tests/test_schedule.py` 29 個（驗證、時段與下一場、狀態機各階段、輸出封包、API 與 409、存檔）；`frontend/tests/schedule.test.ts` 9 個。
- 開發機實跑（2026-11-04 15:10–15:12，目標 `127.0.0.1`，用 UDP 6454 監聽第 1 台 universe 0）：在時段中途啟用排程後，馬達 channel 457／458 立刻變成 60／255（第 1 台設中速逆轉），LED 全暗 3 秒（暖機）後串接從第 1 段亮起；15:12:00 時段結束時 457 立即變 0、方向維持 255、LED 淡出 3 秒，15:12:03 起整包全 0。排程啟用期間 `PUT /api/motor` 回 409。休息階段因為目前串接一輪約 5.75 分鐘，沒有實跑，由單元測試涵蓋。
- 現場待確認：5 秒暖機是否足夠讓馬達到全速；現場電腦時區是否為台北；重新開機後是否直接進入正確階段（和 M7 的開機自動啟動一起測）。

### 9.8 改版：燈光全天、馬達對齊輪次（2026-11-06，v0.3.0）

- 需求：排程啟用時燈光 24 小時循環播放，只在指定時段運轉馬達；馬達要在「最靠近指定開始時間、且不晚於它的那一輪」開始前幾秒先轉（不需要緩啟動），時段內不休息，一直轉到時段結束；結束時這一輪沒播完就播完才停。保留排程開關。
- 行為與規則見 `system-reference.md` 1.8：排程不再改燈光或重播，輪的邊界由播放位置決定；Schedule v2 拿掉 `restMinutes`、`endFadeSeconds`，v1 檔案仍可讀取。
- 測試：`backend/tests/test_schedule.py` 29 個（含輪次對齊、剛好在邊界、收尾、播放重新開始時不停、下一個時段接續、v1 讀取）；backend 全部 168、frontend 133 個測試通過。
- 開發機實跑（2026-11-06 23:55 – 11-07 00:06，一輪 13796 影格 ≈ 344.9 秒，時段 00:00–00:01，提前 5 秒，用 UDP 6454 監聽第 1 台 universe 0）：狀態預估馬達 23:59:22 啟動；實際 23:59:22.302 457 變 60（第 1 台中速逆轉），距離下一輪開頭 5.00 秒；時段 00:01 結束後繼續轉，00:05:12.207 這一輪播完、新一輪開頭時 457 變 0、方向維持 255。期間第 1 台有 1880／26400 包 LED 整條為 0（約 47 秒），來自串接本身（`unit-fade-black`／`fade-black` 轉場與從全暗開始填滿的效果）；排程不改燈光由 `StreamTests` 驗證（有無排程時燈光逐 byte 相同）。

### 9.9 改版：每個時段選持續或循環（2026-11-07，v0.4.0）

- 需求更正：燈光 24 小時都亮；每個時段（每日與特殊日期）各自選「持續」（同 v0.3.0：整段一直轉）或「循環」（同 v0.2.0：時段開始時暖機、從第 1 段播一輪、休息 N 分鐘、暖機後重播，時段結束時馬達立刻停），休息分鐘數每段各自設定。保留排程開關。
- Schedule v3：時段多了 `mode`（`continuous`／`cycle`），循環時段有 `restMinutes`。v1 檔案每段轉成循環（沿用 `restMinutes`），v2 每段轉成持續。模式不同的相鄰時段不合併。規則見 `system-reference.md` 1.8。
- 測試：`backend/tests/test_schedule.py` 39 個（新增循環的完整流程、休息 0、暖機 0、結束立刻停、時段中途啟用、持續與循環互接、v1／v2 轉換、循環暖機後從第 0 影格重播的封包）；backend 全部 178、frontend 133 個測試通過。
- 開發機實跑（2026-11-07 00:20–00:30，一輪 ≈ 344.9 秒，暖機 5 秒；00:22–00:24 循環、休息 1 分鐘，00:24–00:25 持續）：00:22:00.026 馬達啟動（457 = 60），00:22:05 燈光從第 1 段重播（第 1 輪）；00:24:00 循環時段結束、持續時段開始，馬達沒有停；00:25:00 持續時段結束進入收尾，00:27:49.903 這一輪播完時馬達停止。休息階段因為一輪比時段長沒有實跑，由單元測試涵蓋。
