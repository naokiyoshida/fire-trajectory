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

## 8.6 取引 ID をカテゴリ非依存ハッシュへ移行（重複追記の解消・一度きり）

取引 ID の計算式から「大項目/中項目（カテゴリ）」を除外しました。Money Forward ME はカテゴリを後から編集できるため、旧方式（カテゴリ込みハッシュ）ではカテゴリを直すたびに同一取引が別 ID となり二重追記されていました。

新方式は `日付・内容・金額・保有金融機関` の4点でハッシュします。ただし**既存行の ID は旧方式のまま残る**ため、移行しないと次回 `npm run sync` で同じ取引が新 ID と一致せず再度追記されます。下記を **一度だけ** 実行してください。

```powershell
# 1) 影響範囲の確認（書き込まない）
npm run remap-ids -- --dry-run
```

出力で「再計算で ID が変わる行: N」と、再計算後に同一 ID が衝突する行数を確認します（衝突は必ずしも重複ではない。下記参照）。

```powershell
# 2) 実行（取引履歴!A 列の ID を新ハッシュで振り直す）
npm run remap-ids
```

- ID 列のみを書き換えます。日付・金額などの取引データには触れません。
- `⚠ 再計算後に同一 ID が衝突する行` が出ても、**自動削除はしません**（誤って実取引を消さないため）。衝突は2種類あり、`取得日時`(G列) で判別します。スクリプトが各グループの行番号・取得日時・category を出力し判定も付けます:
  - **取得日時が異なる** → 別 run での再追記＝二重追記。**取得日時が新しい行を削除**。
  - **取得日時が同一** → 同一 run で Money Forward が別取引として返した（同日・同額の出金を category 違いで2件記録した等）＝**実取引の可能性が高い。原則どちらも残す**（消すと実支出が欠落）。
- 二重追記でない実取引の衝突を消す必要はありません（消さなくても次回以降の二重追記は止まります）。実際に削除した場合のみ、メニュー **Fire Trajectory → レポートの再構築** で集計を再計算してください。
- **既知の制約**: 新ハッシュは `日付・内容・金額・保有金融機関` の4点のみ。同日・同額・同口座の取引（例: 同じ日に ¥10,000 の ATM 出金を2回）は今後の `sync` で2件目が取りこぼされます。該当パターンが定常的にある場合は、その月の支出を手動補正するか基本生活費設定に織り込んでください。

移行は環境ごとに1回で十分です（以降の `sync` は新ハッシュで動作）。

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

## 10. 開発時のコマンド

```powershell
# 型チェック
npm run lint

# テスト
npm test
npm run test:watch

# 直近 sync の健全性チェック（鮮度・追記件数・成否）
npm run health-check

# 取引 ID をカテゴリ非依存ハッシュへ移行（§8.6、一度きり）
npm run remap-ids -- --dry-run
npm run remap-ids

# 個別 sync (デバッグ用)
npm run sync-transactions:dry  # 取引のみドライラン
npm run sync-assets:dry        # 資産のみドライラン

# 任意のページの HTML スナップショット
npx tsx app/cli.ts snapshot https://moneyforward.com/<path> <label>
```
