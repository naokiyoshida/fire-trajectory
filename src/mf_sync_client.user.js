// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Money Forward MEのデータをGASへ自動同期します。Adaptive Syncにより初回52ヶ月/通常6ヶ月を自動判別。
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @downloadURL  https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
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
            #mf-sync-status.error {
                background: rgba(200, 0, 0, 0.9);
            }
        `;
        document.head.appendChild(style);
    };

    // ステータス表示
    const showStatus = (message, duration = 0, isError = false) => {
        let el = document.getElementById('mf-sync-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mf-sync-status';
            document.body.appendChild(el);
        }
        el.innerText = message;
        el.classList.remove('hidden');
        if (isError) el.classList.add('error');
        else el.classList.remove('error');

        if (duration > 0) {
            setTimeout(() => {
                el.classList.add('hidden');
            }, duration);
        }
    };

    // GAS URLを設定する関数
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GASのウェブアプリURLを入力してください(execで終わるもの):', currentUrl);
        if (newUrl) {
            // URL形式の簡易チェック
            if (!newUrl.includes('/exec')) {
                alert('警告: URLの末尾が "/exec" ではないようです。\n正しい「ウェブアプリURL」かどうか確認してください。\n(スクリプトエディタのURLではありません)');
            }
            await GM_setValue('GAS_URL', newUrl);
            showStatus('GAS URLを保存しました', 3000);
            return newUrl;
        }
        return null;
    };

    // Tampermonkeyメニューに設定コマンドを登録
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);

    // 指定された要素が消えるまで待つ関数
    const waitForElementToDisappear = (...selectors) => {
        return new Promise(resolve => {
            const check = () => !selectors.some(s => document.querySelector(s));
            if (check()) return resolve();

            const observer = new MutationObserver(() => {
                if (check()) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    };

    // GM_xmlhttpRequest を Promise 化したラッパー (CORS回避用)
    const gmFetch = (url, options) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: {
                    "Content-Type": "text/plain;charset=utf-8"
                },
                data: options.body,
                anonymous: true, // 公開ウェブアプリへのアクセスにはanonymous: trueが推奨（Cookie干渉回避）
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP Error: ${response.status} ${response.statusText}`));
                    }
                },
                onerror: (err) => {
                    reject(new Error("Network Error"));
                }
            });
        });
    };

    // リトライ機能付きのfetch関数 (gmFetch使用)
    const fetchWithRetry = async (url, options, retries = 3, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await gmFetch(url, options);
                return response;
            } catch (error) {
                console.warn(`Sync retry ${i + 1}/${retries}: ${error.message}`);
                showStatus(`通信エラー... リトライ中 (${i + 1}/${retries})`);
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    };

    // 複数のセレクタを試して要素を探す関数
    const waitForSyncTarget = (timeout = 10000) => {
        const TARGET_SELECTORS = [
            '#cf-detail-table tbody',
            '#cf-detail-table',
            'section.transaction-section',
            '#transaction_list_body',
            '.js-transaction_table tbody',
            'table.transaction_table tbody'
        ];

        return new Promise((resolve, reject) => {
            const find = () => {
                for (const selector of TARGET_SELECTORS) {
                    const el = document.querySelector(selector);
                    if (el) return { el, selector };
                }
                return null;
            };

            const found = find();
            if (found) return resolve(found);

            const startTime = Date.now();
            const observer = new MutationObserver(() => {
                const found = find();
                if (found) {
                    observer.disconnect();
                    resolve(found);
                } else if (Date.now() - startTime > timeout) {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for targets: ${TARGET_SELECTORS.join(', ')}`));
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                const found = find();
                if (found) resolve(found);
                else reject(new Error(`Timeout waiting for targets: ${TARGET_SELECTORS.join(', ')}`));
            }, timeout);
        });
    };

    // DOM診断用関数
    const diagnoseDOM = () => {
        console.group("【fire-trajectory】DOM診断レポート");
        console.log("URL:", window.location.href);
        console.log("Tables found:", document.querySelectorAll('table').length);
        document.querySelectorAll('table').forEach((t, i) => {
            console.log(`Table[${i}]: id="${t.id}", class="${t.className}"`);
        });
        console.log("Main content check:", document.querySelector('#main') ? "Found" : "Not Found");
        console.groupEnd();
    };

    async function runSync() {
        showStatus("同期プロセスを開始...");
        console.log("【fire-trajectory】同期プロセスを開始します...");

        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl || gasUrl.includes('/macros/library/') || !gasUrl.includes('/exec')) {
            showStatus("GAS URLが不正または未設定です", 0, true);
            alert("【設定エラー】\nGASのURLが正しく設定されていません。\n\n現在の値: " + (gasUrl || "未設定") + "\n\n・「ライブラリ(library)」のURLになっていませんか？\n・末尾が「/exec」になっている「ウェブアプリURL」を使用してください。\n・GASエディタの「デプロイ」→「デプロイを管理」からURLをコピーしてください。");

            await new Promise(r => setTimeout(r, 500));
            gasUrl = await promptAndSetGasUrl();
            if (!gasUrl) {
                showStatus("GAS URL未設定のため中断", 5000, true);
                return;
            }
        }

        let activeSelector = null;
        try {
            const result = await waitForSyncTarget(5000);
            activeSelector = result.selector;
            console.log(`【fire-trajectory】対象テーブルを検出しました (Selector: ${activeSelector})`);
        } catch (e) {
            console.warn("初期表示で明細テーブルが見つかりませんでした。明細0件の可能性があります。ナビゲーションボタンを探します...");
        }

        const scrapeCurrentPage = () => {
            if (!activeSelector || !document.querySelector(activeSelector)) {
                const targets = [
                    '#cf-detail-table tbody',
                    '#cf-detail-table',
                    'section.transaction-section',
                    '#transaction_list_body',
                    '.js-transaction_table tbody',
                    'table.transaction_table tbody'
                ];
                for (const sel of targets) {
                    if (document.querySelector(sel)) {
                        activeSelector = sel;
                        console.log(`【Re-detected】テーブル検出: ${activeSelector}`);
                        break;
                    }
                }
            }

            const currentBody = activeSelector ? document.querySelector(activeSelector) : null;
            if (!currentBody) return [];
            return scrapeFromElement(currentBody);
        };

        const scrapeFromElement = (element) => {
            const rows = element.querySelectorAll('tr');
            const data = [];
            rows.forEach(row => {
                const getText = (cls) => row.querySelector(`.${cls}`)?.innerText.trim();

                let date = getText('date');
                let content = getText('content');
                let amountRaw = getText('amount');
                let source = getText('source') || row.querySelector('.account')?.innerText.trim();
                let category = getText('category') || row.querySelector('.category-name')?.innerText.trim();

                if (!date || !content || !amountRaw) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 5) {
                        if (!date) date = cells[0]?.innerText.trim();
                        if (!content) content = cells[1]?.innerText.trim();
                        if (!amountRaw) amountRaw = cells[2]?.querySelector('span')?.innerText.trim() || cells[2]?.innerText.trim();
                        if (!source) source = cells[3]?.innerText.trim();
                        if (!category) category = cells[4]?.innerText.trim();
                    }
                }

                if (date && content && amountRaw) {
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

            let syncSettings;
            try {
                // GASはリクエストボディの中身を単純なテキストとして返すこともある。
                // 確実にJSONパースを試みる
                syncSettings = JSON.parse(resConfig.responseText);
            } catch (e) {
                console.error("Invalid Response:", resConfig.responseText.slice(0, 500));
                // 認証エラーHTMLの場合
                if (resConfig.responseText.trim().startsWith('<')) {
                    throw new Error("GASがHTMLエラーを返しました。\n\n【重要】GASのURLが『最新版』か確認してください。\n1. Tampermonkeyの機能メニューから「GAS URLを再設定」を選択\n2. GASのデプロイ管理画面で『最新の』ウェブアプリURLをコピーして設定\n※URLはデプロイのたびに変わる場合があります！");
                }
                throw new Error("GASからの応答が不正です (JSONパースエラー): " + e.message);
            }

            if (syncSettings.status === 'error') throw new Error(syncSettings.message);

            showStatus(`モード: ${syncSettings.mode} で同期開始`);

            const monthsToSync = syncSettings.mode === 'Full' ? 52 : 6;
            let allData = [];

            // 2. 複数月のデータをスクレイピング
            for (let i = 0; i < monthsToSync; i++) {
                showStatus(`データ取得中: ${i + 1}ヶ月目`);

                if (i > 0) await new Promise(r => setTimeout(r, 2000));

                const data = scrapeCurrentPage();
                console.log(`Month ${i + 1}: ${data.length} items found.`);
                allData.push(...data);

                if (i < monthsToSync - 1) {
                    const prevButtons = [
                        '#bda-in-closing-month-asset a:first-child',
                        '.transaction_list .pagination .prev a',
                        'button.btn-prev-month',
                        'a.fc-button-prev',
                        'a.btn-prev',
                        '.previous_month',
                        '#menu_range_prev'
                    ];

                    let prevMonthButton = null;
                    for (const sel of prevButtons) {
                        const btn = document.querySelector(sel);
                        if (btn) {
                            prevMonthButton = btn;
                            break;
                        }
                    }

                    if (prevMonthButton) {
                        try {
                            prevMonthButton.click();
                            await waitForElementToDisappear('#loading', '#loading-overlay', '.loading-spinner');
                        } catch (err) {
                            console.warn("ページ遷移エラー", err);
                            break;
                        }
                    } else {
                        if (i === 0) {
                            showStatus("エラー: 移動ボタンが見つかりません", 5000, true);
                            diagnoseDOM();
                        }
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

                let result;
                try {
                    result = JSON.parse(resSync.responseText);
                } catch (e) {
                    console.error("Invalid Response (Sync):", resSync.responseText.slice(0, 500));
                    throw new Error("GASからの応答が不正です。");
                }

                if (result.status === 'error') throw new Error(result.message);
                showStatus(`完了: ${result.count}件同期しました`, 5000);
                setTimeout(() => { window.close(); }, 3000);
            } else {
                showStatus("送信するデータがありません (0件)", 5000);
            }
            console.log("同期処理完了");

        } catch (e) {
            console.error(e);
            showStatus(`エラー: ${e.message}`, 10000, true);
            alert(`エラーが発生しました: ${e.message}`);
        }
    }

    // 初期化処理
    try {
        addStyles();
        showStatus("MF Sync: 待機中...");
        runSync();
    } catch (e) {
        console.error("Critical Error", e);
    }
})();