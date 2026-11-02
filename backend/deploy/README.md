# Windows 部署

Backend、建置好的前端和服務包裝程式 WinSW 打包成同一個「版本化、不可變 release」，部署到現場的 Windows 10／11 電腦。現場電腦不 clone repository、不 `git pull`；每次部署都指向固定 Git tag 的 GitHub Release（`whyixd/moon_observe_re`，public，不需要 token）。

| 檔案 | 用途 |
| --- | --- |
| `build_release.py` | 開發機：從 Git tag（不是工作目錄）組出 zip：backend runtime、以 `npm ci`／`npm run build` 建置的 `frontend/`、固定 SHA-256 的 WinSW；寫入 `VERSION` 並產生 `SHA256SUMS`。 |
| `bootstrap.ps1` | 現場入口：安裝固定版本的 uv（驗證 SHA-256），取得同一 tag 的 `install-release.ps1` 並執行。 |
| `install-release.ps1` | 下載並驗證 zip、`uv sync --frozen`、建立設定、設定權限與防火牆、切換 `current`、健康檢查，失敗時自動回退。 |
| `uninstall.ps1` | 停止並移除服務、防火牆規則與 `C:\MoonObserve`；預設保留設定與 log。 |
| `moon-observe.xml` | WinSW 服務設定範本；安裝時代入路徑與 port。 |

三個 `.ps1` 以系統內建的 **Windows PowerShell 5.1** 為準，而且只能用 ASCII 字元：5.1 讀取沒有 BOM 的檔案時會用系統字碼頁（繁中 Windows 是 cp950），中文會變成亂碼。`backend/tests/test_release.py` 會檢查這點，以及 PowerShell 7 才有的語法。

## 主機配置

```text
C:\MoonObserve\                        只有 Administrators 可寫；LocalService 與 Users 唯讀
├── current -> releases\v0.2.0         junction；停止服務後切換
├── releases\<VERSION>\                內含 .venv、frontend\、deploy\ 與 .install-complete
├── service\MoonObserve.exe            WinSW（每次啟用時從 release 複製）
├── service\MoonObserve.xml            由 deploy\moon-observe.xml 產生
├── bin\uv.exe                         固定版本的 uv
└── .uv-cache\ .uv-python\             uv 的下載快取與 Python（跨版本保留）
C:\ProgramData\MoonObserve\            LocalService 唯讀
├── config.toml                        只在缺少時建立，升級不覆寫
├── github-token                       選填；只有 Administrators 可讀
├── preset\                            LocalService 可寫：preset.json、sequence.json、palette.json
└── logs\                              LocalService 可寫：MoonObserve.out.log、.err.log、.wrapper.log
```

`config.toml` 第一次由 `config.example.toml` 產生，`render.preset`、`render.sequence` 與（註解中的）`weather.palette` 會改到 `preset\` 底下；啟用 `[weather]` 時請一併取消 `palette` 那行的註解，否則 `palette.json` 會落在服務不能寫的資料夾。

## 0. 現場電腦的準備（只做一次）

以系統管理員身分開 Windows PowerShell：

```powershell
# Art-Net 網卡：固定 IP 2.0.0.99/24，不設預設閘道（避免搶走 Wi-Fi 的對外路由）。
# 現場那台（Realtek PCIe GbE）已經設好；網卡名稱是中文（乙太網路），所以用 InterfaceIndex 指定。
Get-NetAdapter | Format-Table Name, InterfaceDescription, ifIndex, Status
$nic = (Get-NetAdapter | Where-Object InterfaceDescription -like 'Realtek PCIe GbE*').ifIndex
Get-NetIPAddress -InterfaceIndex $nic -AddressFamily IPv4                       # 應該有 2.0.0.99/24
# 沒有時才設定：New-NetIPAddress -InterfaceIndex $nic -IPAddress 2.0.0.99 -PrefixLength 24
1..5 | ForEach-Object { Test-Connection -Count 1 "2.0.0.10$_" }               # 接上控制器後，五台都要回應

# Wi-Fi 設成私人網路：控制頁的防火牆規則只開在私人網路。
Get-NetConnectionProfile
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private

# 不睡眠、硬碟不休眠；時區（天氣整點造訪會用到）。
powercfg /change standby-timeout-ac 0
powercfg /change disk-timeout-ac 0
Set-TimeZone -Id "Taipei Standard Time"
```

另外在「設定 → Windows Update」設定使用時段。重新開機後服務會自動啟動（延遲自動啟動），不需要登入。

## 1. 建置與發布（開發機）

Artifact 只從 tag 內容產生，沒有 commit 的修改不會進 release。開發機需要 Node.js／npm 和 uv；WinSW 第一次會下載到 `dist\.cache\`，之後每次都檢查固定的 SHA-256。

```bash
git tag v0.2.0
uv run --project backend python backend/deploy/build_release.py v0.2.0   # → dist/moon-observe-v0.2.0-windows.zip、dist/SHA256SUMS
git push origin master
git push origin v0.2.0
gh release create v0.2.0 dist/moon-observe-v0.2.0-windows.zip dist/SHA256SUMS backend/deploy/bootstrap.ps1 \
  --repo whyixd/moon_observe_re --title v0.2.0 --generate-notes
```

版本格式為 `vMAJOR.MINOR.PATCH`，可以加 `-rc.1` 之類的後綴；builder 和兩個 `.ps1` 用同一個 regex（由測試檢查，PowerShell 端用區分大小寫的 `-cnotmatch`）。同版本重建要加 `--force`，同一個 tag 重建出來的 zip 逐 byte 相同。

## 2. 首次安裝（現場電腦）

從 GitHub Release 下載 `bootstrap.ps1`，以系統管理員身分開 Windows PowerShell：

```powershell
cd $HOME\Downloads
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Version v0.2.0
```

已經把 zip 和 `SHA256SUMS` 放在本機時（例如測試還沒發布的版本），改用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Version v0.2.0 `
  -ArtifactPath .\moon-observe-v0.2.0-windows.zip -SumsPath .\SHA256SUMS
```

uv 仍然要上網下載 Python 3.12 和 `stupidartnet`（之後留在 `.uv-cache`、`.uv-python`）。

首次安裝會註冊服務，但**不啟動**。先檢查設定：

```powershell
notepad C:\ProgramData\MoonObserve\config.toml
```

- 確認 0 節的網卡設定完成後，取消 `source_ip = "2.0.0.99"` 的註解，Art-Net 才會固定從 Ethernet 送出。沒有綁定時，網路線一拔，Art-Net 會改從 Wi-Fi 送到預設閘道（2.0.0.0/8 是公網位址）；綁定後網路線沒插時服務會啟動失敗並自動重試，不會送到別處。
- 五台 `[[artnet.targets]]`（2.0.0.101–105、`universes = [0, 1]`）和 `[hardware]`、`[motor]` 已經是 LongN 的設定。
- 要用天氣時，填入現場經緯度並取消 `palette` 的註解。

```powershell
Start-Service MoonObserve
Get-Service MoonObserve
Get-Content C:\ProgramData\MoonObserve\logs\MoonObserve.out.log -Wait
```

控制頁：同一個 Wi-Fi 的裝置開 `http://<電腦的 Wi-Fi IP>:8765/`；電腦本機開 `http://127.0.0.1:8765/`。後端開機後馬達一律停止，要在「後端」分頁手動開啟。

## 3. 升級

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Version v0.3.0
# 或用目前版本裡的 installer：
powershell -NoProfile -ExecutionPolicy Bypass -File C:\MoonObserve\current\deploy\install-release.ps1 -Version v0.3.0
```

順序：下載 → SHA-256 驗證 → 檢查 zip 內的路徑 → 解壓 → `uv sync --frozen` → 用新版執行 `run.py --check` 驗證現有設定 → 停止服務（關燈、馬達停）→ 切換 `current` → 更新 WinSW 檔案 → 啟動 → 健康檢查。切換前任何一步失敗，服務繼續跑舊版。中斷而殘留、沒有 `.install-complete` 的 release 會在下次安裝時清掉。

健康檢查：30 秒內服務為 Running、`http://127.0.0.1:8765/api/state` 和 `http://127.0.0.1:8765/` 都回應，而且 3 秒後仍正常、服務的 process 沒有換（沒有自動重啟）。失敗時自動切回前一版並啟動，installer 以非 0 結束。成功後保留最近 3 個 release（另外一定保留目前與前一版）。

## 4. 回退

對已安裝的版本重跑 installer，不需要網路，同樣會驗證設定並做健康檢查：

```powershell
Get-ChildItem C:\MoonObserve\releases          # 可用的版本
powershell -NoProfile -ExecutionPolicy Bypass -File C:\MoonObserve\current\deploy\install-release.ps1 -Version v0.2.0
```

## 5. 移除

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\MoonObserve\current\deploy\uninstall.ps1             # 保留 C:\ProgramData\MoonObserve
powershell -NoProfile -ExecutionPolicy Bypass -File C:\MoonObserve\current\deploy\uninstall.ps1 -RemoveData # 連設定與 log 一起刪
```

## 6. 執行模型

- WinSW 以 `NT AUTHORITY\LocalService` 執行 `C:\MoonObserve\current\.venv\Scripts\python.exe -B run.py --config C:\ProgramData\MoonObserve\config.toml --frontend-dir C:\MoonObserve\current\frontend --api-port 8765`，不經 `uv run`。
- 延遲自動啟動；異常結束時 5／10／30 秒後重啟，一小時後重新計算。
- **停止**：WinSW 送 Ctrl+C；後端把 Ctrl+C、Ctrl+Break 和 SIGTERM 都轉成同一個結束流程，每個 universe 送兩次全 0（燈全暗、馬達停），15 秒內沒結束才強制終止。啟動時也會重新打開可能被父程序停用的 Ctrl+C 處理。這不是緊急停止；Art-Net 中斷時控制器不會自動停止馬達。
- 只有 `preset\` 和 `logs\` 可寫；程式資料夾只有 Administrators 可寫。
- 防火牆只在**私人網路**設定檔開放 TCP 8765；沒有閘道的 Art-Net 網卡會被判定為公用網路，不會開放。API 沒有驗證，請只接在受信任的網路。
- log 依大小輪替（每個 10 MB、保留 8 個）。

## 7. 現場驗收（M7）

在現場電腦依序確認，結果記到 `PLAN.md`：

1. **安裝**：`bootstrap.ps1` 完成，`Get-Service MoonObserve` 為 Running，控制頁打得開，五台的燈有反應。
2. **停止時馬達確實停下**：在「後端」分頁讓幾台全速轉，執行 `Stop-Service MoonObserve`，確認燈全暗、馬達停止，`MoonObserve.out.log` 最後一行是 `Stopped.`。也用「重新啟動電腦」各試一次。
3. **升級**：裝一個新版本（可以是 `-rc` 版），健康檢查通過，`C:\MoonObserve\current` 指向新版。
4. **回退**：對前一版重跑 installer，成功切回。
5. **自動回退**：故意裝一個會失敗的版本（例如設定不相容的 `-rc`），確認 installer 自己切回前一版。

## 8. 可調整的參數

`install-release.ps1` 和 `bootstrap.ps1` 的參數（都有預設值）：

| 參數 | 預設 | 用途 |
| --- | --- | --- |
| `-Version` | （必填） | 要安裝或重新啟用的 tag |
| `-ArtifactPath`、`-SumsPath` | 無 | 使用本機的 zip 與 `SHA256SUMS` |
| `-Repository` | `whyixd/moon_observe_re` | GitHub owner/repo |
| `-InstallRoot` | `C:\MoonObserve` | 程式、release、uv 的位置 |
| `-DataRoot` | `C:\ProgramData\MoonObserve` | 設定、preset、log 的位置 |
| `-PromptToken`（bootstrap） | 關 | repo 改成 private 時，輸入並保存 token（Contents: Read） |
| `-KeepReleases`（installer） | `3` | 保留的 release 數 |
| `-HealthTimeout`（installer） | `30` | 健康檢查秒數 |
| `-Port`（installer） | `8765` | 控制頁 port（服務參數、健康檢查與防火牆一起改） |

改過 `-InstallRoot`、`-DataRoot` 或 `-Port` 時，之後升級要帶相同參數。

## 9. 現況限制

- 三個 `.ps1` 在開發機上只做靜態檢查（ASCII、版本 regex、5.1 語法、`-UseBasicParsing` 等），沒有實際執行；第一次要在 Windows 上照第 7 節走一遍。
- WinSW 的 SHA-256 是 2026-11-03 從 GitHub Release 下載後記下的（GitHub 沒有公布官方雜湊），之後的下載都比對這個值。uv 的雜湊取自官方發布的 `.sha256`。
- 沒有 CI 自動建置與發布，也沒有獨立簽章；`SHA256SUMS` 和 zip 來自同一個 GitHub Release，只能偵測傳輸損壞。
- 第一次安裝某個版本需要網路（Python 與套件）；完全離線安裝不在範圍內。
- 帶 token 的下載路徑（repo 改成 private 時才用）還沒有實際跑過。
- 健康檢查只確認程式與本機 API 存活；`stupidArtnet` 沒有接收確認，燈與馬達的實際行為要現場確認。
