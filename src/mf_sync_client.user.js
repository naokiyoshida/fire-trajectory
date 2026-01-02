// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Money Forward MEのデータをGASへ自動同期します。Adaptive Syncにより初回52ヶ月/通常6ヶ月を自動判別。
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @downloadURL  https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    async function runSync() {
        console.log("【fire-trajectory】同期プロセスを開始します...");

        // GASのURLを取得、未設定ならユーザーに問い合わす
        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            gasUrl = prompt('GASのデプロイメントURLを入力してください:');
            if (gasUrl) {
                await GM_setValue('GAS_URL', gasUrl);
            } else {
                console.error("【エラー】GASのURLが設定されていません。");
                return;
            }
        }

        // ページ遷移を待つためのヘルパー関数
        const waitForPageLoad = () => new Promise(resolve => {
            const listener = () => {
                window.removeEventListener('load', listener);
                resolve();
            };
            window.addEventListener('load', listener);
        });
        
        // 現在のページのデータを抽出する関数
        const scrapeCurrentPage = () => {
            const tableBody = document.getElementById('transaction_list_body');
            if (!tableBody) {
                console.warn("【fire-trajectory】明細テーブルが見つかりません。");
                return [];
            }
            const rows = tableBody.querySelectorAll('tr');
            const data = [];
            rows.forEach(row => {
                // インデックスではなく、クラス名で要素を特定する
                const date = row.querySelector('.date')?.innerText.trim();
                const content = row.querySelector('.content')?.innerText.trim();
                const amountRaw = row.querySelector('.amount')?.innerText.trim();
                const source = row.querySelector('.source')?.innerText.trim();
                const category = row.querySelector('.category')?.innerText.trim();

                if (date && content && amountRaw && source && category) {
                    data.push({
                        date: date,
                        content: content,
                        amount: amountRaw.replace(/[,円\s]/g, ''),
                        source: source,
                        category: category
                    });
                }
            });
            console.log(`【fire-trajectory】${data.length}件のデータを抽出しました。`);
            return data;
        };

        try {
            // 1. GASから同期モードを取得
            console.log("【fire-trajectory】GASから同期モードを取得中...");
            const resConfig = await fetch(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });
            const syncSettings = await resConfig.json();
            console.log("【fire-trajectory】同期モード: ", syncSettings.mode);

            const monthsToSync = syncSettings.mode === 'Full' ? 52 : 6;
            let allData = [];

            // 2. 複数月のデータをスクレイピング
            console.log(`【fire-trajectory】${monthsToSync}ヶ月分のデータ取得を開始します。`);
            for (let i = 0; i < monthsToSync; i++) {
                console.log(`【fire-trajectory】${i + 1}ヶ月目のデータを取得中...`);
                
                // 現在のページのデータを収集
                allData.push(...scrapeCurrentPage());

                // 最後の月でなければ、前の月へ移動
                if (i < monthsToSync - 1) {
                    const prevMonthButton = document.querySelector('#bda-in-closing-month-asset a:first-child');
                    if (prevMonthButton) {
                        prevMonthButton.click();
                        await new Promise(resolve => setTimeout(resolve, 3000)); // ページ遷移の待機
                    } else {
                        console.error("【fire-trajectory】「前の月へ」ボタンが見つかりません。同期を中断します。");
                        break;
                    }
                }
            }
            
            // 重複データを除外（ページ遷移の過程で同じデータが複数回取得される可能性があるため）
            const uniqueData = allData.filter((v, i, a) => a.findIndex(t => (t.date === v.date && t.content === v.content && t.amount === v.amount)) === i);
            console.log(`【fire-trajectory】合計${uniqueData.length}件のユニークなデータを収集しました。`);

            // 3. GASへデータを送信
            if (uniqueData.length > 0) {
                console.log("【fire-trajectory】GASへデータを送信中...");
                const resSync = await fetch(gasUrl, {
                    method: "POST",
                    body: JSON.stringify({ action: "sync_data", data: uniqueData })
                });
                const result = await resSync.json();
                console.log("【fire-trajectory】送信結果: ", result.status, "件数:", result.count);
            }

            console.log("【fire-trajectory】完了。2秒後に閉じます。");
            setTimeout(() => { window.close(); }, 2000);

        } catch (e) {
            console.error("【fire-trajectory】エラー発生: ", e);
        }
    }

    // 読み込み完了後に実行
    window.addEventListener('load', () => {
        setTimeout(runSync, 3000);
    });
})();