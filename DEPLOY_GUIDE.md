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
- `Database` (取引明細)
- `Assets_Monthly` (資産スナップショット 1行追記)
- `Manual_Assets` (空、後述の手動入力用)

その後、Sheets を開いてメニューバーの **Fire Trajectory → シミュレーションの再構築** を実行（GAS が `Dashboard` と `Simulation` を作成）。続けて **Fire Trajectory → レポートの再構築** を実行（`Report_CashFlow`、`Report_Spending`、`Report_NetWorth`、`Report_Allocation`、`Report_FIRE_Readiness` を作成）。

GAS メニューが見えない場合は `clasp push` でGASコードをアップロードしてください:
```powershell
npm install -g @google/clasp
clasp login
clasp clone <SCRIPT_ID> --rootDir .
clasp push
```

### 6.1 Manual_Assets の使い方

マネフォME に未連携の資産（インテグレ等の未上場株式）は `Manual_Assets` シートで手動管理します。

| key (A列) | value (B列) | notes (C列) |
|---|---|---|
| stocks_unlisted | 1550000 | インテグレ等の未上場株式 |
| notes | 任意の補足メモ | |

`stocks_unlisted` の値は次回 `npm run sync` で `Assets_Monthly.stocks_unlisted` に取り込まれ、`total_assets` に加算されます。

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

## 10. 開発時のコマンド

```powershell
# 型チェック
npm run lint

# テスト
npm test
npm run test:watch

# 個別 sync (デバッグ用)
npm run sync-transactions:dry  # 取引のみドライラン
npm run sync-assets:dry        # 資産のみドライラン

# 任意のページの HTML スナップショット
npx tsx app/cli.ts snapshot https://moneyforward.com/<path> <label>
```
