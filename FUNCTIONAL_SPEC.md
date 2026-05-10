# 機能仕様書: fire-trajectory

- プロジェクト名: fire-trajectory (自由への軌道)
- バージョン: 2.0
- 最終更新日: 2026/05/10
- 役割: FIRE 計画の意思決定材料となる数値を月次で自動更新するシステム

---

## 1. 全体アーキテクチャ

```
[Windows タスクスケジューラ] ─起動→ [scripts/run-sync.ps1] ─実行→ [Node.js / Playwright]
                                                                       │
                                                                       ├─ マネフォME ログイン (storageState 再利用)
                                                                       ├─ 取引履歴スクレイプ (/cf?year=Y&month=M)
                                                                       ├─ 資産スナップショット (/bs/portfolio + /bs/liability)
                                                                       └─ Google Sheets API 書き込み
                                                                       │
                                                                       ▼
                                                                [Google Sheets]
                                                                       │
                                                                       ▼
                                                                [GAS スクリプト]
                                                                  setupSimulation / setupReports
                                                                       │
                                                                       ▼
                                                                [Claude プロジェクト]
                                                                  Drive コネクタ経由で参照
```

数値層 (本リポジトリ) とナラティブ層 (Claude プロジェクト「資産運用計画」) の責任分担:

- 数値層: 実データの収集と数式ベースの予測。客観値の管理
- ナラティブ層: 目標年齢、戦略、前提条件の議論。主観・判断の管理

---

## 2. 階層分離アーキテクチャ

スクレイピング部分は5層に分離されており、マネフォME のサイト変更に対する影響範囲を局所化できる。

| 層 | ファイル | 責務 | サイト変更時の影響 |
|---|---|---|---|
| Navigator | `navigator.ts` | URL遷移、月送り、ヘッダー検証 | ボタン位置の変化 |
| Extractor | `extractor.ts` | DOM → 生データ | クラス名・構造の変化 |
| Selectors | `selectors.yml` | CSS セレクタ集（フォールバック付き） | **大半の変化はここだけ** |
| Schema | `schema.ts` | zod による型・整合性検証 | フィールド増減 |
| Transformer | `transformer.ts` | 内部表現 → Sheets 形式 | データフォーマット変化 |

各層は独立してテスト可能で、`tests/scrapers/**` に純関数のユニットテストがある（28本、vitest）。

---

## 3. データモデル

### 3.1 Database シート（取引明細）

Node が `Google Sheets API` で書き込み。

| 列 | 名称 | 型 | 説明 |
|---|---|---|---|
| A | ID | string (SHA256) | 重複排除用ハッシュ。`SHA256(date-content-amount-source-category)` |
| B | 日付 | string (`YYYY/MM/DD`) | 取引日 |
| C | 内容 | string | 取引内容 |
| D | 金額 | string (Sheets が数値推論) | 円。マイナス = 支出 |
| E | 保有金融機関 | string | 例: 「エポスカード (直樹)」 |
| F | 大項目/中項目 | string | 例: 「食費/食料品」 |
| G | 取得日時 | string (ISO 8601) | スクリプト実行タイムスタンプ |

**重複排除**: 既存A列のIDセットを取得して、新規分のみ追記。
**振替・除外**: マネフォME 上で「振替」または「計算対象外」フラグの行はスキップ。

### 3.2 Assets_Monthly シート（資産スナップショット）

Node が月1回 1行追記。当月分が既存ならスキップ（冪等）。

| 列 | 名称 | 型 | 説明 |
|---|---|---|---|
| A | snapshot_date | string (`YYYY-MM-DD`) | スナップショット日（JST） |
| B | cash | int | 預金・現金・暗号資産（外貨建て口座も含む） |
| C | stocks_listed | int | 株式（現物） |
| D | stocks_unlisted | int | Manual_Assets の `stocks_unlisted` から |
| E | funds | int | 投資信託 |
| F | pension | int | 年金（DC含む） |
| G | points | int | ポイント・マイル |
| H | other_assets | int | 上記カテゴリに該当しない資産（マッピング外を集約） |
| I | total_assets | int | scraped 合計 + stocks_unlisted |
| J | credit_card | int | クレジットカード未払残高 |
| K | mortgage | int | 住宅ローン残高 |
| L | other_loans | int | その他ローン（自動車、奨学金、その他の負債） |
| M | total_liabilities | int | 負債総額（マネフォME 表示値） |
| N | net_worth | int | total_assets - total_liabilities |
| O | notes | string | Manual_Assets の `notes` から |

**整合性検証** (zod refine):
- 資産: `cash + stocks_listed + funds + pension + points + other_assets ≈ total_assets_mf`（誤差±1円）
- 負債: `credit_card + mortgage + other_loans ≈ total_liabilities_mf`

### 3.3 Manual_Assets シート（手動入力）

ユーザーが管理。マネフォME に未連携の資産・補足メモ用。

| 列 | 名称 |
|---|---|
| A | key |
| B | value |
| C | notes |

現状の認識キー:
- `stocks_unlisted`: インテグレ等の未上場株式の評価額
- `notes`: スナップショットに添える自由テキスト

### 3.4 Dashboard シート（シミュレーション入力）

GAS の `setupSimulation()` が初期化。B列の既存値があれば保持される（再実行で上書きされない）。

| 行 | 項目 (A列) | 設定値 (B列) | デフォルト値 (D列) |
|---|---|---|---|
| 2 | 本人誕生日 | YYYY/MM/DD | 1977/03/09 |
| 3 | 配偶者誕生日 | YYYY/MM/DD | 1976/06/27 |
| 4 | 現在の資産 | 数式参照 | `Assets_Monthly` 最新の `net_worth` |
| 5 | リタイア予定日 | YYYY/MM/DD | 2037/03/31 |
| 6 | 基本生活費_月額 | int (円) | 350,000 |
| 7 | 運用利回り_名目 | 0.05 | 0.05 |
| 8 | インフレ率 | 0 | 0 |
| 9 | ローン完済予定日 | YYYY/MM/DD | 2042/03/31 |
| 10 | ローン月額 | int (円) | 100,000 |
| 11 | 本人年金_年額 | int (円) | 1,800,000 |
| 12 | 配偶者年金_年額 | int (円) | 780,000 |
| 13 | 息子支援終了日 | YYYY/MM/DD | 2028/03/31 |
| 14 | 息子支援月額 | int (円) | 50,000 |
| 15 | 配偶者年収_年額 | int (円) | 2,400,000 |
| 16 | 配偶者退職予定日 | YYYY/MM/DD | 2041/06/30 |
| 17 | 退職時一時金 | int (円) | 3,000,000 |
| 18 | 本人手取り月収 | int (円) | 500,000 |

デフォルト値はナラティブ層（別 Claude プロジェクト「資産運用計画」）と同期。

### 3.5 Simulation シート（FIRE 月次予測）

GAS が 100歳まで月次360行を構築。

列: 年月 / 本人年齢 / 期首資産 / 収入 / 支出 / 収支 / 実質利回り(月) / 期末資産

### 3.6 Report_* シート群

GAS の `setupReports()` が QUERY 関数ベースで構築。データはすべて Database / Assets_Monthly / Simulation を参照。

- `Report_CashFlow`: 月次収支差・収入・支出（3エリア）
- `Report_Spending`: カテゴリ別支出合計
- `Report_NetWorth`: Assets_Monthly のミラー（snapshot_date / total_assets / total_liabilities / net_worth）
- `Report_Allocation`: 最新月の資産配分（13項目）
- `Report_FIRE_Readiness`: スナップショット日 / 現在純資産 / 100歳時点予想資産 / 65歳時点予想資産 / 資産枯渇月 / 余裕度判定

---

## 4. シミュレーション計算ロジック

### 4.1 実質利回り（フィッシャー方程式）

- 年間実質利回り `r = ((1 + n) / (1 + i)) - 1`
  - `n`: 名目利回り (`Dashboard!B7`)
  - `i`: インフレ率 (`Dashboard!B8`)
- 月次実質利回り `r_m = (1 + r)^(1/12) - 1`
- 資産更新式: `P_t = (P_{t-1} + CF_t) × (1 + r_m)`

### 4.2 ライフイベント制御

`Dashboard` シートの設定値に基づき、月次キャッシュフローを動的に切り替える。

- **収入**:
  - 本人給与: リタイア予定日 (`B5`) まで
  - 配偶者給与: 配偶者退職予定日 (`B16`) まで
  - 本人年金: 65歳到達月以降
  - 配偶者年金: 65歳到達月以降
  - 退職一時金: 配偶者退職月に加算
- **支出**:
  - 基本生活費: 全期間
  - 住宅ローン: 完済予定日 (`B9`) まで
  - 息子支援: 支援終了日 (`B13`) まで

---

## 5. 認証・セキュリティ

### 5.1 マネフォME 認証

- **メールアドレス + パスワード ログインのみ使用**（Google OAuth は Playwright 検出で弾かれる）
- 初回 `npm run login` で headed ブラウザを起動、ユーザーが手で2FAを通す
- Cookie を `data/storage-state.json` に永続化（gitignore済み）
- 以降はヘッドレスで自動再開

### 5.2 ヘッドレス検出回避

`app/core/browser.ts` で次の対策を実施:
- User-Agent をデスクトップ Chrome に偽装（`HeadlessChrome/...` を排除）
- `navigator.webdriver` を `undefined` に上書き
- viewport / locale / timezone を実環境に揃える

### 5.3 Sheets API 認証

- Google サービスアカウント方式（`config/google-service-account.json`、gitignore済み）
- スコープ: `https://www.googleapis.com/auth/spreadsheets`
- スプレッドシートはサービスアカウントの `client_email` に編集者権限で共有

### 5.4 通知

- 失敗時に Gmail SMTP 経由でユーザーにメール送信（オプション）
- 設定方法: `.env` に `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `NOTIFY_EMAIL`
- Gmail 側で 2段階認証 + アプリパスワード発行が前提

---

## 6. 設計原則

### MUST
- 既存の取引・資産データを破壊しない（重複排除と冪等性で担保）
- 失敗時にユーザーに気づける形で通知（数ヶ月空白を防ぐ）
- 取得項目の小計と合計の整合性を検証（zod refine）

### SHOULD
- セレクタは外部 YAML 化し、コード変更なしで追従可能にする
- スクレイピング対象は月1回に絞り、過剰アクセスを避ける
- ログを残す（成功・失敗・件数）

### MUST NOT
- マネフォME に **Google OAuth でログインしない**（Playwright 検出で弾かれる）
- 認証情報をリポジトリにコミットしない
- 過去のスナップショットを上書きしない
- 住信SBIネット銀行のような「意図的に未連携」の口座を勝手に追加しない

---

## 7. テスト戦略

vitest による純関数ユニットテスト 28本:
- `tests/scrapers/transactions/transformer.test.ts`: SHA256 ID 生成、重複排除
- `tests/scrapers/transactions/extractor.test.ts`: 金額クリーニング、日付パース
- `tests/scrapers/transactions/navigator.test.ts`: 月送りロジック、ヘッダー判定
- `tests/scrapers/assets/extractor.test.ts`: 円通貨パース
- `tests/scrapers/assets/transformer.test.ts`: scraped + manual の合算
- `tests/auth/session.test.ts`: ログインURL判定
- `tests/core/sheets-client.test.ts`: 列番号変換

ブラウザ操作・Sheets API は実機ドライランで検証:
- `npm run sync:dry`: ブラウザを起動してスクレイピングのみ、Sheets 書き込みなし
- `npm run check-session`: ヘッドレスで取引ページに到達できるか

---

## 8. スコープ外

- 完全クラウド化（マネフォの 2FA・Cookie 管理が複雑なためローカル実行を維持）
- 取引のカテゴリ自動分類精度向上
- 個別証券会社の API 直叩き（マネフォ集約方針を維持）
- ナラティブ層（意思決定・前提条件）の自動化（Claude プロジェクト側で人手管理）
