# デプロイ・運用ガイド: fire-trajectory

初回セットアップから月次自動実行までの手順。一度終わらせれば、以降は月1回タスクスケジューラが自動起動するだけになります。

## 1. 前提環境

- Windows 10/11
- Node.js 22 以上 (`node --version` で確認)
- Google アカウント
- Money Forward ME アカウント（プレミアム会員推奨だが必須ではない）
- マネフォME に **「メールアドレス + パスワード」ログイン** が設定済みであること（Google ログインは Playwright の自動化検出で弾かれるため使えない）

## 2. リポジトリ準備

```powershell
git clone <repo-url>
cd fire-trajectory
npm install
npx playwright install chromium
```

## 3. Google Cloud / Sheets セットアップ

Node が Sheets に書き込むため、サービスアカウント認証を使います。

### 3.1 Google Cloud プロジェクト作成

1. <https://console.cloud.google.com/> で新規プロジェクト作成（既存利用可）
2. 「APIとサービス」→「ライブラリ」→ **Google Sheets API** を有効化

### 3.2 サービスアカウント作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」
2. 名前は任意（例: `fire-trajectory-bot`）。ロール選択はスキップ可
3. 作成後、そのサービスアカウントを開き「キー」タブ→「鍵を追加」→「新しい鍵を作成」→「JSON」
4. ダウンロードした JSON ファイルをプロジェクトの `config/google-service-account.json` に保存（`config/` ディレクトリは無ければ作成）
5. JSON の `client_email` フィールド（例: `xxx@yyy.iam.gserviceaccount.com`）を控える

### 3.3 スプレッドシート作成

1. <https://sheets.google.com/> で新規スプレッドシート作成
   - 既存の GAS プロジェクトに紐付いているシートがあればそれでも可
2. URL から ID を抽出: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`
3. シートを開き、右上「共有」→ サービスアカウントの `client_email` を **編集者** 権限で追加

### 3.4 `.env` 設定

`.env.template` をコピーして `.env` を作り、必須項目を埋めます。

```powershell
Copy-Item .env.template .env
```

```
GOOGLE_SHEET_ID=<3.3 で取得した ID>
GOOGLE_SERVICE_ACCOUNT_JSON=config/google-service-account.json
```

## 4. マネフォME ログイン

```powershell
npm run login
```

ブラウザが立ち上がるので **「メールアドレスでログイン」** を選んで認証。2FA を有効にしているなら入力。ダッシュボードに到達したらターミナルに戻って Enter。

`data/storage-state.json` に Cookie が保存され、以降はヘッドレスで自動実行できます。

```powershell
npm run check-session
```

`Session valid: true` が出れば成功。`false` の場合は `npm run login` をやり直してください。

## 5. 動作確認（ドライラン）

Sheets に書き込まずスクレイピングだけ確認できます。

```powershell
npm run sync:dry
```

期待出力:
- 取引: `scraped=NNN, unique=NNN`
- 資産: `total_assets`, `total_liabilities`, `net_worth` の数値表示

## 6. 本番同期 + GAS 初期化

```powershell
npm run sync
```

初回実行で Sheets に以下が作られます:
- `取引履歴` (取引明細)
- `資産推移` (資産スナップショット 1行追記)
- `手動入力資産` (空、後述の手動入力用)

その後、Sheets を開いてメニューバーの **Fire Trajectory → シミュレーションの再構築** を実行（GAS が `設定` と `シミュレーション` を作成）。続けて **Fire Trajectory → レポートの再構築** を実行（`月次収支`、`カテゴリ別支出`、`純資産推移`、`資産配分`、`FIRE射程` を作成）。

GAS メニューが見えない場合は `clasp push` でGASコードをアップロードしてください:
```powershell
npm install -g @google/clasp
clasp login
clasp clone <SCRIPT_ID> --rootDir .
clasp push
```

### 6.1 「手動入力資産」シートの使い方

マネフォME に未連携の資産（未上場株式など）は `手動入力資産` シートで手動管理します。

| 項目 (A列) | 値 (B列) | 備考 (C列) |
|---|---|---|
| 未上場株式 | 1550000 | 未上場の自社株など |
| 備考 | 任意の補足メモ | |

「未上場株式」の値は次回 `npm run sync` で `資産推移.株式（未上場）` に取り込まれ、`資産総額` に加算されます。`手動入力資産` の「項目」列は厳密に一致させる必要があります（現在対応しているラベルは `未上場株式` と `備考` の2つだけ）。

> **未上場株式（インテグレ等）はここに入れるべき？（二重計上注意）**
> 未上場株式は Money Forward のポートフォリオ自動取得（`/bs/portfolio`）には**含まれません**。本ツールは「資産総額 ＝ MF取得合計 ＋ 本シートの未上場株式」として合算します。
> - **原則**: MF に登録していても、ここ（`未上場株式` 行の値）に評価額を入力してください（スクレイプ対象の資産総額には反映されないため）。
> - **例外**: MF 側で未上場株式が `/bs/portfolio` の「資産総額」に既に含まれて表示されている場合は、ここに入れると**二重計上**になるので空欄(0)に。
> - 判定: `/bs/portfolio` の「資産総額」にインテグレ評価額が入っているかで決めます。`手動入力資産` シート右側（E:H 列）にも同じ説明を自動表示しています。

## 7. タスクスケジューラ登録（月次自動化）

### 7.1 タスク作成

1. 「タスク スケジューラ」を開く
2. 「タスクの作成」（基本タスクではなく）を選択
3. **全般タブ**:
    - 名前: `fire-trajectory monthly sync`
    - 「ログオンしているときのみ実行する」を選択（推奨）
    - 「最上位の特権で実行する」は不要
4. **トリガータブ**: 新規 → 月次 → 毎月1日 09:00 など
5. **操作タブ**: 新規 → プログラム/スクリプトを開始
    - プログラム: `powershell.exe`
    - 引数: `-ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\Workspaces\fire-trajectory\scripts\run-sync.ps1"`
6. **設定タブ**:
    - 「タスクが既に実行中の場合に適用される規則」: 「新しいインスタンスを開始しない」
    - 「タスクが要求時に実行されるようにする」: ON

### 7.2 動作確認

タスクを右クリック→「実行」で手動起動。`logs/sync-YYYY-MM-DD.log` に実行ログが追記されます。

## 8. メール通知（オプション）

失敗時にメール通知を受け取りたい場合:

1. Gmail で 2段階認証を有効化（設定済みなら不要）
2. Google アカウント → セキュリティ → **アプリパスワード** を発行（16文字）
3. `.env` に追加:
   ```
   GMAIL_USER=your.address@gmail.com
   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
   NOTIFY_EMAIL=your.address@gmail.com
   ```
4. 失敗時に `[fire-trajectory ERROR] <command> failed` というメールが届きます

未設定の場合は ConsoleNotifier にフォールバックし、ログにのみ出力されます。

## 8.5 既存環境を日本語シート名に切り替える（マイグレーション）

過去バージョンで構築した `Database` / `Assets_Monthly` / `Manual_Assets` / `Dashboard` / `Simulation` / `Report_*` シートを抱えている場合の移行手順。

1. `git pull` 後、`clasp push` で最新の GAS スクリプトをアップロード
2. Sheets を開き、ダミーシート（一時的な空シート）を1つ作成しておく
   - Sheets はすべてのシートを削除できないため、削除前に1枚以上残す必要がある
3. 旧シートをまとめて削除:
   `Database` / `Assets_Monthly` / `Manual_Assets` / `Dashboard` / `Simulation` / `Report_CashFlow` / `Report_Spending` / `Report_NetWorth` / `Report_Allocation` / `Report_FIRE_Readiness`
4. ターミナルで Full Sync を実行:
   ```powershell
   npm run sync:full
   ```
   → `取引履歴` / `資産推移` / `手動入力資産` の3シートが日本語ヘッダーで新規作成される
5. `手動入力資産` の A 列に手動入力のラベルを再登録:
   - 1 行目はヘッダー (`項目` / `値` / `備考`、自動作成済み)
   - 2 行目以降に `未上場株式` / `備考` のラベルで値を入れ直す
   - **旧 `stocks_unlisted` / `notes` のラベルは無視される**ため必ず日本語に直すこと
6. メニュー **Fire Trajectory → シミュレーションの再構築** を実行 → `設定` / `シミュレーション` 作成
7. メニュー **Fire Trajectory → レポートの再構築** を実行 → `月次収支` / `カテゴリ別支出` / `純資産推移` / `資産配分` / `FIRE射程` 作成
8. 手順2で作ったダミーシートを削除

これで全 10 シートが日本語名で揃う。タスクスケジューラの設定変更は不要（PowerShell スクリプトはシート名に依存しない）。

## 8.6 ハッシュ方式変更後の重複解消（再 sync → dedupe・一度きり）

取引 ID は `日付・内容・金額・保有金融機関` の自然キー＋同一キー衝突時の**出現順 occurrence(0,1,2…)** で算出します（category は MF で後編集できるため意図的に除外）。

ハッシュ方式を変えると**既存行の ID は旧方式のまま**残るため、次回 `npm run sync` が同期窓（直近 `SYNC_MONTHS` ヶ月）の取引を新 ID で再取得し、その分だけ一時的に二重追記されます。

> **旧 `remap-ids` は廃止しました。** 「シート値から ID を再計算して振り直す」方式は、過去フル同期が金額を `¥20` / `-¥5,949` のような書式付き表現で保存しているなど、現行スクレイパの正規化出力（`-5949` 等）と一致せず破綻し、全件を二重追記する事故を起こしました。ID を触らず行の素性で重複を消す下記の手順が安全です。

手順:

```powershell
# 1) いったん通常同期（同期窓の取引が新 ID で再追記される＝想定どおり）
npm run sync

# 2) 重複解消の確認（書き込まない）
npm run dedupe-rows -- --dry-run

# 3) 重複行を削除
npm run dedupe-rows
```

`dedupe-rows` は **ID を一切変更せず**、正規化自然キー（金額の ¥・カンマ・「円」・空白を除去）でグルーピングし、同一キーに**取得日時(G列)が複数 run ぶん**あるものを「同じ取引の再追記」とみなして**最新 run の行だけ残し旧 run の行を削除**します。

- 同一 run（取得日時が同じ）の同一キー複数行は、同日・同額・同口座の**別取引**（occurrence で別 ID 済み）として保持されます。削除されません。
- 旧 run にしか存在しない取引（MF 側で後から削除された等で再取得されなかったもの）は単一取得日時なので保持されます。
- **残余エッジ**: Money Forward が同一自然キー取引の相対並び順を run 間で入れ替えた場合のみ、当該取引が一度だけ再追記され得ます（稀。`dedupe-rows` 再実行で解消可、無言の取りこぼしより安全側）。

移行は環境ごとに1回で十分です（以降の `sync` は新方式で安定動作）。

## 9. トラブルシューティング

### 9.1 セッション切れ
`check-session` で false が返る場合は `npm run login` をやり直し。

### 9.2 マネフォの DOM 構造変化
`scraped=0` や `ScrapingError: ... selector ...` が出たら、`app/scrapers/{transactions,assets}/selectors.yml` の CSS セレクタを更新してください。実機 HTML は `npm run dev snapshot https://moneyforward.com/cf cf-debug` などで保存できます。

### 9.3 ヘッドレス検出
将来マネフォME がヘッドレスをさらに厳しく検出するようになった場合、`app/core/browser.ts` の `DEFAULT_USER_AGENT` を最新 Chrome に更新してください。それでも通らない場合は `playwright-extra` + `puppeteer-extra-plugin-stealth` を導入する案があります。

### 9.4 タスクスケジューラから動かない
- `logs/sync-YYYY-MM-DD.log` を確認
- `npm.cmd` のパスがランチャの想定 (`C:\Program Files\nodejs\npm.cmd`) と違う場合は `scripts/run-sync.ps1` を編集
- PATH 関連で `node` が見つからないケースが多いので、ランチャ内で絶対パス指定済み

### 9.5 同期が「成功扱い」なのに実は止まっている
`scripts/run-sync.ps1` は毎回 sync 後に `npm run health-check` を実行し、`logs/last-sync-status.json`（最終 sync の成否・時刻・追記件数）を検証します。次のいずれかで異常（終了コード非0＋メール通知）になります:

- 状態ファイルが無い（一度も成功していない）
- 直近 sync が失敗
- 最終成功が約40日より古い（＝月次タスクが起動していない疑い）
- 直近 sync は成功扱いだが取引追記0件（セッション失効・画面変更の疑い）

手動でも `npm run health-check` で同じ判定を確認できます。`Session valid` チェック（9.1）と合わせて、無人運用の沈黙故障を早期に可視化します。

### 9.6 シート整合性の一括診断（`npm run doctor`）と追記前ガード

ID 方式の不整合（remap-ids 級の事故）を疑ったら、まず **`npm run doctor`**（読み取り専用・書き込みなし）。1コマンドで以下を出力します:

- 総行数
- A列の重複ID（種別数・行数・サンプル / **本来0**）
- 旧 run 重複行数（`dedupe-rows` 対象）
- **最新 run の「保存ID vs 現行 transformer 再計算ID」一致率**（`423/423 一致 (100%)` 等。100%未満なら次回 sync が二重追記する恐れ＝方式不整合のサイン）
- 最終 sync の health 判定

異常時は終了コード非0（重複ID=4 / 最新 run 不一致=5）。**症状の自己診断はこれを実行して出力を見るだけで足ります**（使い捨て調査スクリプトは不要）。

**`npm run sync:peek`**（= `sync-transactions --dry-run --peek`）は、既存IDを読むが**書き込みは一切しない**ドライランで、「次の sync は何件追記するか」の**真の件数**を出します（通常の `sync:dry` はフルモードで既存照合をしないため常に全件表示になり、この用途には使えません）。

**追記前ガード**: 通常の `npm run sync` は、増分モードで「走査ユニークの過半数（かつ50件以上）が新規」になると、サイレント二重追記をせず `ScrapingError: 追記前ガード中止 …` で停止します（remap-ids 事故の再発防止）。正当な大量差分（長期停止後など）と確認できたら `npm run sync -- --force` で続行できます。

### 9.7 FIRE シミュレーション（インタラクティブ HTML）

**`npm run sim`**（読み取り専用）: 設定シートを読み、`dist/fire.html` を生成します。ブラウザで `file://…/dist/fire.html` を開くとスライダーで設定を動かしながら「期末資産 vs FIRE必要資産」グラフと FIRE 可能時期がリアルタイム更新されます（完全ローカル・外部送信なし）。`npm run sync` 末尾でも best-effort で自動再生成（失敗しても sync は成功扱い）。`dist/` は gitignore。

**`npm run sim -- --check`**: engine の出力を現行「シミュレーション」シートと月次でパリティ比較し、最大差と最初の乖離行を表示します。**この合否が「Sheets シミュレーション撤去 OK」のゲート**です（exit 6 = 乖離あり＝撤去不可）。撤去はパリティ合格ログを根拠に別コミットで実施し、取引履歴・資産推移・設定シートは残します。

**任意項目の補完**: 設定シートに `退職後社会保険料_月額` 等の新項目行が無い場合、既定値で続行しつつ `[warn] …任意項目を既定値で補完…` を出します。正確を期すなら設定シートに行を追加してください（既定 0 は支出過小評価＝FIRE が楽観側に出ます）。

## 10. 開発時のコマンド

```powershell
# 型チェック
npm run lint

# テスト
npm test
npm run test:watch

# 直近 sync の健全性チェック（鮮度・追記件数・成否）
npm run health-check

# 取引履歴シートの一括診断（読み取り専用・§9.6）。異常時 exit 非0
npm run doctor

# FIRE シミュレーション HTML 生成（読み取り専用・§9.7）
npm run sim
npm run sim:check             # ＋現行 Sheets とパリティ比較（撤去ゲート）

# ハッシュ方式変更後の重複解消（§8.6、再 sync 後に一度きり）
npm run dedupe-rows -- --dry-run
npm run dedupe-rows

# 個別 sync (デバッグ用)
npm run sync:peek             # 既存照合あり・書き込みなしで真の新規件数を確認（§9.6）
npm run sync-assets:dry       # 資産のみドライラン

# 任意のページの HTML スナップショット
npx tsx app/cli.ts snapshot https://moneyforward.com/<path> <label>
```
