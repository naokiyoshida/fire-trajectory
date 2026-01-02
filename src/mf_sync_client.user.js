// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Money Forward MEのデータをGASへ自動同期します。Adaptive Syncにより初回52ヶ月/通常6ヶ月を自動判別。
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @downloadURL  https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // GAS URLを設定する関数
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GASのデプロイメントURLを入力してください:', currentUrl);
        if (newUrl) {
            await GM_setValue('GAS_URL', newUrl);
            alert('GASのURLを保存しました。');
            return newUrl;
        }
        return null;
    };

    // Tampermonkeyメニューに設定コマンドを登録
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);

    // 指定された要素が出現するまで待つ関数
    const waitForElement = (selector, parent = document.body) => {
        return new Promise(resolve => {
            const el = parent.querySelector(selector);
            if (el) {
                return resolve(el);
            }
            const observer = new MutationObserver(mutations => {
                const targetEl = parent.querySelector(selector);
                if (targetEl) {
                    observer.disconnect();
                    resolve(targetEl);
                }
            });
            observer.observe(parent, {
                childList: true,
                subtree: true
            });
        });
    };

    // 指定された要素が消えるまで待つ関数
    const waitForElementToDisappear = (selector, parent = document.body) => {
        return new Promise(resolve => {
            if (!parent.querySelector(selector)) {
                return resolve();
            }
            const observer = new MutationObserver(mutations => {
                if (!parent.querySelector(selector)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(parent, {
                childList: true,
                subtree: true
            });
        });
    };

    // リトライ機能付きのfetch関数
    const fetchWithRetry = async (url, options, retries = 3, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    throw new Error(`サーバーエラー: ${response.status} ${response.statusText}`);
                }
                return response;
            } catch (error) {
                console.error(`【fire-trajectory】fetch試行 ${i + 1}/${retries} 回目失敗:`, error.message);
                if (i === retries - 1) throw error; // 最後の試行で失敗したらエラーをスロー
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    };

    async function runSync() {
        console.log("【fire-trajectory】同期プロセスを開始します...");

        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            console.log("【fire-trajectory】GAS URLが未設定です。設定を促します。");
            gasUrl = await promptAndSetGasUrl();
            if (!gasUrl) {
                console.error("【エラー】GASのURLが設定されていません。処理を中断します。");
                return;
            }
        }
        
        const scrapeCurrentPage = () => {
            // (scrapeCurrentPage関数の実装は変更なし)
            const tableBody = document.getElementById('transaction_list_body');
            if (!tableBody) {
                console.warn("【fire-trajectory】明細テーブルが見つかりません。");
                return [];
            }
            const rows = tableBody.querySelectorAll('tr');
            const data = [];
            rows.forEach(row => {
                const date = row.querySelector('.date')?.innerText.trim();
                const content = row.querySelector('.content')?.innerText.trim();
                const amountRaw = row.querySelector('.amount')?.innerText.trim();
                const source = row.querySelector('.source')?.innerText.trim();
                const category = row.querySelector('.category')?.innerText.trim();
                if (date && content && amountRaw && source && category) {
                    const amount = amountRaw.replace(/[,円\s]/g, '');
                    const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                    const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);
                    data.push({ id: hashId, date, content, amount, source, category });
                }
            });
            console.log(`【fire-trajectory】${data.length}件のデータを抽出しました。`);
            return data;
        };

        try {
            // 1. GASから同期モードを取得
            console.log("【fire-trajectory】GASから同期モードを取得中...");
            const resConfig = await fetchWithRetry(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });
            const syncSettings = await resConfig.json();
            if(syncSettings.status === 'error') throw new Error(syncSettings.message);
            console.log("【fire-trajectory】同期モード: ", syncSettings.mode);

            const monthsToSync = syncSettings.mode === 'Full' ? 52 : 6;
            let allData = [];

            // 2. 複数月のデータをスクレイピング
            console.log(`【fire-trajectory】${monthsToSync}ヶ月分のデータ取得を開始します。`);
            for (let i = 0; i < monthsToSync; i++) {
                console.log(`【fire-trajectory】${i + 1}ヶ月目のデータを取得中...`);
                allData.push(...scrapeCurrentPage());

                if (i < monthsToSync - 1) {
                    const prevMonthButton = document.querySelector('#bda-in-closing-month-asset a:first-child');
                    if (prevMonthButton) {
                        prevMonthButton.click();
                        await waitForElementToDisappear('#loading');
                    } else {
                        console.error("【fire-trajectory】「前の月へ」ボタンが見つかりません。同期を中断します。");
                        break;
                    }
                }
            }
            
            const uniqueData = allData.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
            console.log(`【fire-trajectory】合計${uniqueData.length}件のユニークなデータを収集しました。`);

            // 3. GASへデータを送信
            if (uniqueData.length > 0) {
                console.log("【fire-trajectory】GASへデータを送信中...");
                const resSync = await fetchWithRetry(gasUrl, {
                    method: "POST",
                    body: JSON.stringify({ action: "sync_data", data: uniqueData })
                });
                const result = await resSync.json();
                if(result.status === 'error') throw new Error(result.message);
                console.log("【fire-trajectory】送信結果: ", result.status, "件数:", result.count);
            }

            console.log("【fire-trajectory】完了。2秒後に閉じます。");
            setTimeout(() => { window.close(); }, 2000);

        } catch (e) {
            console.error("【fire-trajectory】エラー発生: ", e);
            alert(`同期処理中にエラーが発生しました。\n詳細はデベロッパーツールのコンソールを確認してください。\n\nエラー内容: ${e.message}`);
        }
    }

    // ページの主要コンテンツ（明細テーブル）が表示されたら同期処理を開始
    waitForElement('#transaction_list_body').then(runSync);
})();