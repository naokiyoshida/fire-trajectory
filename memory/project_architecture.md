---
name: fire-trajectory architecture (legacy, migration in progress)
description: 旧3層構成と既存シートの役割。2026-05-10にPlaywright+Nodeへの一本化を決定済み。詳細はarchitecture_migration.md
type: project
---

**注意: 2026-05-10 アーキテクチャ移行決定済み。詳細は architecture_migration.md を参照。**

旧3層構成（Phase 7 で `mf_sync_client.user.js` `RunSyncHidden.ps1` 削除予定）:
1. `mf_sync_client.user.js` (Tampermonkey, @match=`/cf*` のみ): マネフォ取引履歴をスクレイプしGASへPOST
2. `gas_receiver_service.gs` (GAS Web App): 受信、Database重複排除、Simulation構築（フィッシャー方程式、ライフイベント制御込み）
3. `RunSyncHidden.ps1` (タスクスケジューラ起動): Chromeを `?force_auto_sync=true` でバックグラウンド起動

**Why:** ナラティブ層（別Claudeプロジェクト「資産運用計画」）が前提条件と戦略を管理し、こちらは生データと予測数値を担当する分担。

**How to apply:** 仕様書に「マネフォ取得スクリプト」とだけ書かれていても、実体はこの3層を全部指す。Task追加時は実装場所を3層のどこにするか明示する。

既存シート:
- `Database`: 取引明細（日本語ヘッダー: ID/日付/内容/金額/保有金融機関/大項目・中項目/取得日時）
- `Dashboard`: シミュレーション**入力**パラメータ17項目（A項目名/B設定値/C説明/Dデフォルト値）。setupSimulation再実行でB列はクリアされない設計
- `Simulation`: 100歳まで月次360行のFIRE試算（既に実装済み、フィッシャー方程式・ライフイベント制御済み）

新シートは `Report_*` プレフィックスで命名し、既存`Dashboard`と衝突を避ける合意済み。
