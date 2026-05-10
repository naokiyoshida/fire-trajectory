---
name: Architecture migration to Playwright + Node.js
description: 2026-05-10 決定。Tampermonkey + PowerShell + GAS から Playwright + Node + GAS に一本化する移行を進行中
type: project
---

2026-05-10、3層構成（Tampermonkey + PowerShell + GAS）から Playwright + Node.js + GAS に一本化することが決定された。一括移行（並行運用なし）。

**Why:** 既存3層構成は DOM 脆弱性、Chrome表示のちらつき、設定3箇所分散、テスト不可能、PC稼働必須など複数の弱点があった。ユーザーは「自動化重視・月次でOK・言語自由」を希望し、規約リスクと自動化の両立として Playwright によるローカル月次実行が最良と判断。

**How to apply:**
- 新コードは TypeScript + Playwright + googleapis (Sheets API) で書く
- 既存 `mf_sync_client.user.js` `RunSyncHidden.ps1` は Phase 7 で削除予定
- 既存 `gas_receiver_service.gs` は doPost / sync_data 系を削除し、`setupSimulation` と新規 `setupReports` のみ残す方向
- スケジュール: 月次1回（取引・資産まとめて）。バランス案ではなく最小頻度を選択
- 認証: Playwright storageState で Cookie 永続化。初回のみユーザーが手動ログイン (2FA含む)、以降ヘッドレス
- ローカル実行を起点とし、必要になればクラウド (Cloud Run / GitHub Actions) に同じコードで移行可能な設計とする
- 既存 GAS の Simulation シート構築ロジック（フィッシャー方程式、ライフイベント制御、月次360行）は温存

ナラティブ層に合わせる前提値:
- 基本生活費: 月35万
- 配偶者収入: 月20万 (年240万)
- 本人年金: 月15万 (年180万)
- 配偶者年金: 月6.5万 (年78万)
- 退職一時金: 300万
- 想定利回り: 5%
- インフレ率: 0

## 進捗 (2026-05-10 時点)

完了:
- Phase 1-7 全コード実装、テスト 35/35 通過
- Sheets セットアップ (サービスアカウント認証、共有設定)
- Full Sync 機能 (`--full` フラグ、`FULL_SYNC_START=2021/10` がデフォルト) 実装と実機実行
- タスクスケジューラ登録 + StartWhenAvailable=true (PC不在月の追いかけ実行)
- run-sync.ps1 は ASCII コメントのみ (PowerShell 5.1 のUTF-8 BOMなし誤読を回避済み)
- **シート名・列名の日本語化（コード側）完了**: Node の `app/pipeline/sync-{transactions,assets}.ts` と `src/gas_receiver_service.gs` を全面書き換え。`app/core/sheets-client.ts` に `quoteSheetName` ヘルパー、GAS 側は `quoteSheetName_` を導入し、A1 表記は全て `'シート名'!範囲` 形式。`ASSETS_KEY_ORDER` で内部キーと日本語ヘッダー列順を分離。

未完 (ユーザー操作待ち):
- 日本語化を Sheets に反映するためのユーザー手順:
  1. `clasp push` で更新後の GAS をアップロード
  2. Sheets で旧シート (Database / Assets_Monthly / Manual_Assets / Dashboard / Simulation / Report_*) を全削除
     (ダミーシートを残しておかないと「最後のシート削除不可」で詰まる)
  3. `npm run sync:full` で「取引履歴」「資産推移」「手動入力資産」を Node が新規作成 (日本語ヘッダー)
  4. 「手動入力資産」の A 列に「未上場株式」「備考」のラベルで再入力 (旧 stocks_unlisted/notes は無視される)
  5. メニュー「Fire Trajectory → シミュレーションの再構築」「→ レポートの再構築」で残り 7 シートを構築
- メール通知 (Gmail アプリパスワード設定はユーザー任意)

リネーム決定（実装済み）:
- 取引履歴 / 資産推移 / 手動入力資産 / 設定 / シミュレーション
- 月次収支 / カテゴリ別支出 / 純資産推移 / 資産配分 / FIRE射程
- 資産推移の列: 基準日/預金・現金/株式（現物）/株式（未上場）/投資信託/年金/ポイント/その他資産/資産総額/クレジット未払/住宅ローン/その他負債/負債総額/純資産/備考
- 手動入力資産: 項目/値/備考。受け付けるラベルは「未上場株式」(→stocks_unlisted) と「備考」(→notes) のみ
