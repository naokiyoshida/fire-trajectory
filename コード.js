// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Money Forward MEのデータをGASへ自動同期します。Adaptive Syncにより初回52ヶ月/通常6ヶ月を自動判別。
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @grant        none
// @require      file:///G:/%E3%83%9E%E3%82%A4%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96/Workspaces/fire-trajectory/src/fire-config.js
// ==/UserScript==

(function() {
    'use strict';

    // 外部ファイルからPRIVATE_CONFIGを取得する関数
    const getConfig = () => {
        if (typeof PRIVATE_CONFIG !== 'undefined') return PRIVATE_CONFIG;
        if (window.PRIVATE_CONFIG) return window.PRIVATE_CONFIG;
        return null;
    };

    async function runSync() {
        console.log("【fire-trajectory】同期プロセスを開始します...");
        const config = getConfig();

        if (!config || !config.GAS_URL) {
            console.error("【エラー】fire-config.jsの読み込みに失敗しました。var PRIVATE_CONFIG が定義されているか確認してください。");
            return;
        }

        try {
            // 1. GASへの導通確認（昨日と同じシンプルなfetch）
            console.log("【fire-trajectory】GAS通信テスト中...");
            const resConfig = await fetch(config.GAS_URL, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });
            const syncSettings = await resConfig.json();
            console.log("【fire-trajectory】同期モード: ", syncSettings.mode);

            // 2. データ抽出（昨日成功したロジック）
            const tableBody = document.getElementById('transaction_list_body');
            if (!tableBody) {
                console.warn("【fire-trajectory】明細テーブルが見つかりません。");
                return;
            }

            const rows = tableBody.querySelectorAll('tr');
            const data = [];
            rows.forEach(row => {
                const cols = row.querySelectorAll('td');
                if (cols.length >= 5) {
                    data.push({
                        date: cols[1]?.innerText.trim(),
                        content: cols[2]?.innerText.trim(),
                        amount: cols[3]?.innerText.replace(/[,円\s]/g, '').trim(),
                        source: cols[4]?.innerText.trim(),
                        category: cols[5]?.innerText.trim()
                    });
                }
            });
            console.log(`【fire-trajectory】${data.length}件のデータを抽出しました。`);

            // 3. GASへデータを送信
            if (data.length > 0) {
                const resSync = await fetch(config.GAS_URL, {
                    method: "POST",
                    body: JSON.stringify({ action: "sync_data", data: data })
                });
                const result = await resSync.json();
                console.log("【fire-trajectory】送信結果: ", result.status);
            }

            console.log("【fire-trajectory】完了。2秒後に閉じます。");
            setTimeout(() => { window.close(); }, 2000);

        } catch (e) {
            console.error("【fire-trajectory】エラー発生: ", e);
        }
    }

    // 読み込み完了後に実行（昨日のタイミングに合わせる）
    window.addEventListener('load', () => {
        setTimeout(runSync, 3000);
    });
})();