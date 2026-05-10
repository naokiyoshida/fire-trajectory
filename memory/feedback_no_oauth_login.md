---
name: Avoid OAuth login flows in Playwright
description: マネフォME のログインで Google/Yahoo OAuth を使うと Playwright が自動化ブラウザとして検出されブロックされる
type: feedback
---

マネフォME のログインフローで Google/Yahoo の OAuth 認証を経由してはいけない。Google は `navigator.webdriver` 等のフラグで Playwright/Puppeteer が起動した Chromium を「安全でないブラウザ」と判定して `accounts.google.com/v3/signin/rejected` でブロックする。

**Why:** 2026-05-10 に Phase 2 のログインフロー実機確認時に、ユーザーがマネフォの「Googleでログイン」を選択して `accounts.google.com/v3/signin/rejected?app_domain=https%3A%2F%2Fid.moneyforward.com` で「ログインできませんでした / このブラウザまたはアプリは安全でない可能性があります」エラーになった。Google の検出は年々厳しくなっており、stealth プラグインでも長期的には回避困難。

**How to apply:**
- マネフォME 側で「メールアドレス + パスワード」によるログインを有効化し、その経路を使う
- Playwright のログインフローでは必ずメアド/PW 入力欄を使う（Google ログインボタンは押さない）
- 別サービスで同様に Playwright/Puppeteer ログイン自動化が必要になった場合も、まずネイティブ（メアド/PW）認証を試し、OAuth は最後の手段にする
- どうしても OAuth が必要な場合は launchPersistentContext + 実 Chrome (channel: "chrome") + 既存ログイン済みプロファイル流用が次善策
