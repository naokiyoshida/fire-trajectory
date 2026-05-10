---
name: マネフォME のヘッドレス検出回避策
description: ヘッドレス Playwright だと /cf にアクセスしても /sign_in にリダイレクトされる。UA偽装と navigator.webdriver 隠しで通る
type: feedback
---

マネフォME (https://moneyforward.com/cf 等) はヘッドレスブラウザを検出してログイン画面にリダイレクトする。Playwright の素のヘッドレスでは Cookie が有効でもセッション無効と判定される。

**Why:** 2026-05-10 に Phase 2 動作確認時に判明。ヘッドフル(headless=false)では同じ Cookie で正常に取引ページに到達できるが、ヘッドレスでは `/sign_in` にリダイレクトされていた。

**How to apply:**
- `app/core/browser.ts` の launchBrowser で次の3点をすでに対策済み:
  1. User-Agent をデスクトップ Chrome に偽装（Playwright デフォルトの `HeadlessChrome/...` を排除）
  2. `navigator.webdriver` を `undefined` に上書き（addInitScript）
  3. viewport / locale / timezone を実利用環境に合わせる
- これで月次自動化はヘッドレスで完結する
- 将来 Chrome のバージョン更新で UA 文字列が古くなったらマネフォ側に検出される可能性あり。その場合は DEFAULT_USER_AGENT を更新する
- もしマネフォの検出が強化されてこれでも通らなくなったら、playwright-extra + stealth プラグイン or headed 運用（タスクスケジューラから --WindowStyle Hidden 起動）に切り替える
- Google OAuth の自動化検出は別物（あちらは強固で UA 偽装では通らない）。OAuth ログインは引き続き使わない方針
