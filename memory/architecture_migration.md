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
- Phase 1-7 全コード実装、テスト 32/32 通過
- Sheets セットアップ (サービスアカウント認証、共有設定)
- Full Sync 機能 (`--full` フラグ、`FULL_SYNC_START=2021/10` がデフォルト) 実装と実機実行
- タスクスケジューラ登録 + StartWhenAvailable=true (PC不在月の追いかけ実行)
- run-sync.ps1 は ASCII コメントのみ (PowerShell 5.1 のUTF-8 BOMなし誤読を回避済み)

未完:
- シート名・列名の日本語化: 方針合意済み (選択A: 全削除→再構築→Full Sync)。コード変更とユーザー側のシート操作が次回タスク
- メール通知 (Gmail アプリパスワード設定はユーザー任意)

リネーム計画 (次回作業時の参照用):
- Database → 取引履歴, Assets_Monthly → 資産推移, Manual_Assets → 手動入力資産
- Dashboard → 設定, Simulation → シミュレーション
- Report_CashFlow → 月次収支, Report_Spending → カテゴリ別支出, Report_NetWorth → 純資産推移, Report_Allocation → 資産配分, Report_FIRE_Readiness → FIRE射程
- 資産推移の列ヘッダー: 基準日/預金・現金/株式（現物）/株式（未上場）/投資信託/年金/ポイント/その他資産/資産総額/クレジット未払/住宅ローン/その他負債/負債総額/純資産/備考
- 手動入力資産: 項目/値/備考。項目ラベルは日本語 (例: 「未上場株式」→ 内部キー stocks_unlisted)
- 全シート名はシングルクォート付きで参照 ('シート名'!範囲)、Node 側は sheets-client に quoteSheetName ヘルパー追加
