// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      2.3
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

(function () {
    'use strict';

    // スタイル設定（ステータス表示用）
    const addStyles = () => {
        const style = document.createElement('style');
        style.textContent = `
            #mf-sync-status {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 10px 15px;
                border-radius: 5px;
                z-index: 9999;
                font-family: sans-serif;
                font-size: 14px;
                transition: opacity 0.5s;
                max-width: 300px;
            }
            #mf-sync-status.hidden {
                opacity: 0;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    };

    // ステータス表示
    const showStatus = (message, duration = 0) => {
        let el = document.getElementById('mf-sync-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mf-sync-status';
            document.body.appendChild(el);
        }
        el.innerText = message;
        el.classList.remove('hidden');
        if (duration > 0) {
            setTimeout(() => {
                el.classList.add('hidden');
            }, duration);
        }
    };

    // GAS URLを設定する関数
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GASのデプロイメントURLを入力してください:', currentUrl);
        if (newUrl) {
            await GM_setValue('GAS_URL', newUrl);
            showStatus('GAS URLを保存しました', 3000);
            return newUrl;
        }
        return null;
    };

    // Tampermonkeyメニューに設定コマンドを登録
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);

    // 指定された要素が出現するまで待つ関数（タイムアウト付き）
    const waitForElement = (selector, timeout = 10000) => {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const startTime = Date.now();
            const observer = new MutationObserver(() => {
                const targetEl = document.querySelector(selector);
                if (targetEl) {
                    observer.disconnect();
                    resolve(targetEl);
                } else if (Date.now() - startTime > timeout) {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for element: ${selector}`));
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // 念のためのタイムアウト設定
            setTimeout(() => {
                observer.disconnect();
                const targetEl = document.querySelector(selector);
                if (targetEl) resolve(targetEl);
                else reject(new Error(`Timeout waiting for element: ${selector}`));
            }, timeout);
        });
    };

    // 指定された要素が消えるまで待つ関数
    const waitForElementToDisappear = (selector) => {
        return new Promise(resolve => {
            if (!document.querySelector(selector)) return resolve();

            const observer = new MutationObserver(() => {
                if (!document.querySelector(selector)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    };

    // リトライ機能付きのfetch関数
    const fetchWithRetry = async (url, options, retries = 3, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) throw new Error(`Status ${response.status}`);
                return response;
            } catch (error) {
                console.warn(`Sync retry ${i + 1}/${retries}: ${error.message}`);
                showStatus(`通信エラー... リトライ中 (${i + 1}/${retries})`);
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    };

    async function runSync() {
        showStatus("同期プロセスを開始...");
        console.log("【fire-trajectory】同期プロセスを開始します...");

        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            showStatus("GAS URL未設定。設定が必要です...");
            // 少し待ってからプロンプトを出す（UI描画との競合を防ぐため）
            await new Promise(r => setTimeout(r, 500));
            gasUrl = await promptAndSetGasUrl();
            if (!gasUrl) {
                showStatus("GAS URL未設定のため中断", 5000);
                return;
            }
        }

        const scrapeCurrentPage = () => {
            const tableBody = document.getElementById('transaction_list_body');
            if (!tableBody) {
                console.warn("明細テーブルが見つかりません");
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
            return data;
        };

        try {
            // 1. GASから同期モードを取得
            showStatus("GASへ接続中...");
            const resConfig = await fetchWithRetry(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });
            const syncSettings = await resConfig.json();
            if (syncSettings.status === 'error') throw new Error(syncSettings.message);

            showStatus(`モード: ${syncSettings.mode} で同期開始`);

            const monthsToSync = syncSettings.mode === 'Full' ? 52 : 6;
            let allData = [];

            // 2. 複数月のデータをスクレイピング
            for (let i = 0; i < monthsToSync; i++) {
                showStatus(`データ取得中: ${i + 1}ヶ月目`);
                allData.push(...scrapeCurrentPage());

                if (i < monthsToSync - 1) {
                    const prevMonthButton = document.querySelector('#bda-in-closing-month-asset a:first-child');
                    if (prevMonthButton) {
                        prevMonthButton.click();
                        await waitForElementToDisappear('#loading');
                    } else {
                        break;
                    }
                }
            }

            const uniqueData = allData.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
            showStatus(`${uniqueData.length}件のデータを送信中...`);

            // 3. GASへデータを送信
            if (uniqueData.length > 0) {
                const resSync = await fetchWithRetry(gasUrl, {
                    method: "POST",
                    body: JSON.stringify({ action: "sync_data", data: uniqueData })
                });
                const result = await resSync.json();
                if (result.status === 'error') throw new Error(result.message);
                showStatus(`完了: ${result.count}件同期しました`, 5000);
            } else {
                showStatus("送信するデータがありません", 3000);
            }

            console.log("完了。");
            setTimeout(() => { window.close(); }, 3000); // ステータスが見えるように少し待つ

        } catch (e) {
            console.error(e);
            showStatus(`エラー: ${e.message}`, 10000);
            alert(`エラーが発生しました: ${e.message}`);
        }
    }

    // 初期化処理
    try {
        addStyles();
        showStatus("MF Sync: ページ読み込み待機中...");

        waitForElement('#transaction_list_body', 10000)
            .then(runSync)
            .catch(e => {
                console.error(e);
                showStatus("待機タイムアウト: 家計簿明細テーブルが見つかりません。", 10000);
            });
    } catch (e) {
        console.error("Critical Error", e);
    }
})();