# fire-trajectory (自由への軌道)

Money Forward ME の取引明細と資産スナップショットを月次で自動収集し、Google Sheets に蓄積して FIRE (Financial Independence, Retire Early) 計画の意思決定材料を最新に保つためのシステムです。

## 構成

```
[Windows タスクスケジューラ]
   │ 月1回 起動
   ▼
[Node.js + Playwright]                       (app/, scripts/)
   ├ マネフォME に自動ログイン (Cookie永続化)
   ├ /cf から過去Nヶ月の取引履歴をスクレイプ
   ├ /bs/portfolio と /bs/liability から資産・負債のスナップショット
   ├ Google Sheets API で書き込み
   └ 失敗時は Gmail で通知
   │
   ▼
[Google Sheets] - 数値層 (シート名はすべて日本語)
   ├ 取引履歴       (取引明細、Node が書き込み)
   ├ 資産推移       (月次の資産スナップショット、Node が書き込み)
   ├ 手動入力資産   (未上場株式等の手動入力、ユーザーが管理)
   ├ 設定           (シミュレーション入力ストア、GAS が初期化)
   └ 月次収支 / カテゴリ別支出 / 純資産推移 / 資産配分
                    (集計レポート、GAS が QUERY で構築)
   │
   ▼
[Claude プロジェクト「資産運用計画」] - ナラティブ層
   Drive コネクタ経由で上記 Sheets を参照し、目標年齢・前提条件・戦略を議論

FIRE 月次予測は Sheets ではなく `npm run sim` が生成する完全ローカルな
インタラクティブ HTML（`dist/fire.html`）。計算の正は `app/sim/engine.ts`。
```

## 主要コンポーネント

| 階層 | パス | 役割 |
|---|---|---|
| エントリポイント | `app/cli.ts` | CLI コマンド (`sync` / `login` / `check-session` / `doctor` / `sim`) |
| 取引スクレイパ | `app/scrapers/transactions/` | navigator / extractor / selectors / schema / transformer |
| 資産スクレイパ | `app/scrapers/assets/` | 同上の構成、`/bs/portfolio` と `/bs/liability` を扱う |
| パイプライン | `app/pipeline/sync-transactions.ts`, `app/pipeline/sync-assets.ts` | スクレイプ → 検証 → Sheets 書き込みの統括 |
| 共通コア | `app/core/` | browser (Playwright), sheets-client (Sheets API), notifier (Gmail SMTP), config (zod), logger, errors |
| 認証 | `app/auth/` | 初回ログインフローと storageState 管理 |
| シミュレーション | `app/sim/` | engine（唯一の正）/ load-inputs / render-html / sliders / template（`dist/fire.html` 生成） |
| GAS | `src/gas_receiver_service.gs` | 「設定」入力ストアと「月次収支」等レポートのシート構築 (`setupSettings`, `setupReports`) |
| ランチャ | `scripts/run-sync.ps1` | Windows タスクスケジューラ用 |
| テスト | `tests/` | vitest による純関数テスト (112本) |

## 設計原則

- **階層分離**: スクレイピングは navigator / extractor / schema / transformer / sink の5層に分け、サイト変更の影響範囲を狭める
- **セレクタ外出し**: CSS セレクタは `selectors.yml` で管理し、コード変更なしで追従できる
- **検証ファースト**: zod スキーマで取得データを検証し、内訳合計と総額の整合性も refine でチェック
- **冪等性**: 当月分の資産スナップショットが既にあれば書き込みをスキップ、取引はハッシュID で重複排除
- **ヘッドレスでも通る**: User-Agent 偽装と `navigator.webdriver` 隠しでマネフォME のヘッドレス検出を回避

## クイックスタート

セットアップ手順は [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) を参照してください。

```powershell
# 依存インストール
npm install
npx playwright install chromium

# 初回ログイン (ヘッドフルでブラウザが開く、メアド + 2FA 入力)
npm run login

# セッション確認
npm run check-session

# Sheets 書き込みなしのドライラン
npm run sync:dry

# 本番同期 (.env 設定後)
npm run sync
```

## ドキュメント

- [機能仕様書](FUNCTIONAL_SPEC.md): アーキテクチャ、データモデル、計算ロジック
- [デプロイガイド](DEPLOY_GUIDE.md): セットアップ、Google Cloud、タスクスケジューラ登録

## ライセンス

[MIT License](LICENSE)

## 免責事項

本ツールは Money Forward ME の公式ツールではありません。利用規約を遵守し、自己責任でご利用ください。スクレイピングの頻度は月次に絞り、過剰なアクセスは避ける設計になっています。
