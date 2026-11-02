# Raspberry Pi 部署

Backend 與 build 好的前端以同一個「版本化、不可變 release」部署到 Raspberry Pi，架構參照 [DEPLOYMENT_ARCHITECTURE.md](../../DEPLOYMENT_ARCHITECTURE.md)（Unobject）。Pi 不 clone repository、不 `git pull`；每次部署都指向固定 Git tag 的 GitHub Release。

| 檔案 | 責任 |
| --- | --- |
| `build_release.py` | 開發機：從 Git tag（非工作目錄）組出最小 tar.gz（backend runtime + 以 `npm ci`／`npm run build` 建置的 `frontend/`）、寫入 `VERSION`、產生 `SHA256SUMS`。 |
| `bootstrap.sh` | Pi 入口：安裝 OS 套件與 uv、保存 GitHub token，從同一 tag 取得 installer 並執行。 |
| `install-release.sh` | 下載並驗證 artifact、建立 `.venv`、seed 持久設定、原子切換、健康檢查與自動回退。 |
| `moon-observe.service` | systemd unit 模板；單一 service 同時輸出 Art-Net 並提供控制頁面與 API；installer 代入路徑與帳號。 |

## 主機配置

```text
/opt/moon-observe/
├── current -> releases/v0.1.0         active release（原子切換）
├── releases/<VERSION>/                root 擁有、唯讀；內含 .venv、frontend/ 與 .install-complete
├── .uv-cache/ .uv-python/ .home/      service user 擁有，跨版本保留
/etc/moon-observe/                     root:moon-observe 0750
├── config.toml                        root:moon-observe 0640，只在缺少時 seed
├── github-token                       root 0600
└── preset/                           moon-observe 擁有；service 唯一可寫位置
    ├── preset.json
    ├── sequence.json                  UI「儲存串接」時建立
    └── palette.json                   啟用 [weather] 且在色盤頁儲存時建立
/etc/systemd/system/moon-observe.service
```

`config.toml` 首次由 `config.example.toml` 產生，並把 `render.preset`、`render.sequence` 與（註解中的）`weather.palette` 改到 `preset/` 底下；啟用 `[weather]` 時請一併取消 `palette` 那行的註解，否則預設的 `palette.json` 位於不可寫的 `/etc/moon-observe/`。`preset.json` 由 `preset.example.json` 產生。升級不覆寫兩者。

## 1. 建置與發布（開發機）

Artifact 只從 tag 內容產生，未 commit 的修改不會進入 release。開發機需要 Node.js／npm：builder 會把 tag 的 `frontend/` 匯出到暫存目錄執行 `npm ci` 與 `npm run build`（含 `tsc` 型別檢查），失敗時不產生 artifact。Pi 不需要 Node.js。

```powershell
git tag v0.1.0
python backend/deploy/build_release.py v0.1.0      # → dist/moon-observe-backend-v0.1.0.tar.gz、dist/SHA256SUMS
git push origin master
git push origin v0.1.0
gh release create v0.1.0 dist/moon-observe-backend-v0.1.0.tar.gz dist/SHA256SUMS backend/deploy/bootstrap.sh backend/deploy/install-release.sh --repo whyixd/moon_observe --title v0.1.0 --generate-notes
```

版本格式為 `vMAJOR.MINOR.PATCH`，可加 `-rc.1` 之類後綴；builder 與兩個 shell script 使用同一 regex（由測試檢查）。同版本重建須加 `--force`，且同一 tag 重建的檔案位元相同。

## 2. 首次安裝（Pi）

需要可存取 `whyixd/moon_observe` 的 GitHub fine-grained token，權限只開 **Contents: Read**。

```bash
# 從開發機複製（bootstrap.sh 不含秘密）
scp backend/deploy/bootstrap.sh pi@<PI_HOST>:/tmp/
# 在 Pi 上
sudo bash /tmp/bootstrap.sh v0.1.0
```

token 從 TTY 隱藏讀取，存成 `/etc/moon-observe/github-token`（0600），不會出現在命令列或 shell history。首次安裝會 enable service，但**不啟動**；先設定 Art-Net 目的 IP：

```bash
sudo nano /etc/moon-observe/config.toml
sudo systemctl start moon-observe
systemctl status moon-observe
journalctl -u moon-observe -f
```

## 3. 升級

```bash
sudo bash /tmp/bootstrap.sh v0.2.0
# 或已安裝過時直接用 active release 內的 installer：
sudo bash /opt/moon-observe/current/deploy/install-release.sh v0.2.0
```

順序：下載 → SHA-256 驗證 → 解壓 → `uv sync --frozen` → 以新版執行 `run.py --check` 驗證現有設定 → 原子切換 `current` → restart → 健康檢查。切換前任何一步失敗，服務仍跑舊版。中斷而殘留的不完整 release 目錄（缺 `.install-complete`）會在下次安裝時自動清除。

健康檢查：在 20 秒內 service 為 active、`http://127.0.0.1:8765/api/state` 與控制頁面 `http://127.0.0.1:8765/` 都回應，且 3 秒後仍正常、沒有自動重啟。失敗時自動切回前一版並 restart，installer 以非 0 結束。成功後保留最近 3 個 release（另外一定保留 current 與前一版）。

## 4. 回退

對已安裝的版本重跑 installer，不需網路或 token，同樣會驗證設定並做健康檢查：

```bash
sudo bash /opt/moon-observe/current/deploy/install-release.sh v0.1.0
ls /opt/moon-observe/releases        # 可用版本
```

## 5. 執行模型

- 以無登入權限的 system user `moon-observe` 執行 `/opt/moon-observe/current/.venv/bin/python run.py --config /etc/moon-observe/config.toml`，不經 `uv run`。
- `KillSignal=SIGINT`：stop/restart 時程式走正常退出，若馬達命令為 `255`，會盡力補送一個 `0`。此功能不是緊急停止；接收端仍需失聯停機機制。
- `Restart=on-failure`、`After=network-online.target`、開機自動啟動；log 進 journald。
- `ProtectSystem=strict`，只有 `/etc/moon-observe/preset` 可寫。
- 控制頁面與 API 綁 `0.0.0.0:8765`：同網段裝置開 `http://<PI_HOST>:8765/`（色盤編輯在 `/palette.html`）。API 沒有驗證，請只接在受信任的網路。

## 6. 可覆寫參數

在 `sudo` 後以環境變數傳入，例如 `sudo MOON_OBSERVE_KEEP_RELEASES=5 bash install-release.sh v0.2.0`。

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `MOON_OBSERVE_REPOSITORY` | `whyixd/moon_observe` | GitHub owner/repo |
| `MOON_OBSERVE_INSTALL_ROOT` | `/opt/moon-observe` | release 與 uv cache 根目錄 |
| `MOON_OBSERVE_CONFIG_ROOT` | `/etc/moon-observe` | 設定、token、preset 根目錄 |
| `MOON_OBSERVE_GITHUB_TOKEN_FILE` | `<CONFIG_ROOT>/github-token` | token 檔 |
| `GITHUB_TOKEN` | 無 | 直接執行 installer 時暫時提供 token |
| `MOON_OBSERVE_SERVICE_USER` | `moon-observe` | service 帳號 |
| `MOON_OBSERVE_KEEP_RELEASES` | `3` | 保留的 release 數 |
| `MOON_OBSERVE_HEALTH_URL` | `http://127.0.0.1:8765/api/state` | 健康檢查 endpoint |
| `MOON_OBSERVE_PAGE_URL` | `http://127.0.0.1:8765/` | 健康檢查的前端頁面 |
| `MOON_OBSERVE_HEALTH_TIMEOUT` | `20` | 健康檢查秒數 |

Unit 由模板產生，路徑與帳號跟著上述變數一起代入；改 root 時 installer 與 service 不會不一致。若改過 root，之後升級須帶相同變數。

## 7. 現況限制

- 沒有 CI 自動建置與發布，也沒有獨立簽章；checksum 與 archive 來自同一個 GitHub Release，只能偵測傳輸損壞。
- uv 由官方 install script 安裝，未固定版本。
- 健康檢查只確認程式與本機 API 存活；`stupidArtnet` 不提供接收確認，LED 與馬達實際行為仍需現場確認。
- 健康檢查要求前端頁面回應，因此回退到不含前端的舊 release（本功能之前打包的版本）會被判定失敗。
