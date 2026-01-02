// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      3.14
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

    // DOM診断用関数 (デバッグ用)
    const diagnoseDOM = () => {
        console.group("【fire-trajectory】DOM診断レポート");
        console.log("URL:", window.location.href);
        console.log("Tables found:", document.querySelectorAll('table').length);
        document.querySelectorAll('table').forEach((t, i) => {
            console.log(`Table[${i}]: id="${t.id}", class="${t.className}"`);
        });
        console.log("Main content check:", document.querySelector('#main') ? "Found" : "Not Found");
        // ボタンも探してみる
        const prevButtons = [
            'button.fc-button-prev',
            '.fc-header-left .fc-button-prev',
            '#bda-in-closing-month-asset a:first-child',
            '.transaction_list .pagination .prev a',
            'button.btn-prev-month',
            'a.fc-button-prev',
            'a.btn-prev',
            '.previous_month',
            '#menu_range_prev'
        ];
        prevButtons.forEach(sel => {
            console.log(`Checking button selector: ${sel} => ${document.querySelector(sel) ? "Found" : "Not Found"}`);
        });

        console.groupEnd();
    };

    // --- メイン処理 ---
    async function runSync(forceFull = false) {
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

        // 対象テーブルの検出
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
                // 再検出
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

        // ページから年を取得する関数 (強化版)
        const getYearFromPage = () => {
            // Check 1: URL Parameter (Standard)
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('year')) {
                const y = urlParams.get('year');
                console.log(`【Debug】Date extraction: URL param 'year' found: ${y}`);
                return y;
            }

            // Check 2: Calendar Title Header / Commonly used date displays
            // Look for any element that looks like a header containing "YYYY年MM月"
            const headerSelectors = [
                '.fc-header-title',
                '.transaction-range-display',
                'h1', 'h2', 'h3',
                '.heading-date',
                '.page-header-title',
                '#term_header',
                '.term',
                '#transaction_list_caption' // Some layouts use this
            ];

            for (const sel of headerSelectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    // Remove whitespace to make matching easier
                    const text = el.innerText.replace(/\s+/g, '');
                    // Match "2024年12月" or just "2024年" if unambiguous
                    const match = text.match(/(\d{4})年(\d{1,2})月/);
                    if (match) {
                        console.log(`【Debug】Date extraction: Header found (${sel}): ${match[1]}年${match[2]}月`);
                        return match[1];
                    }

                    // Year-only match (careful with this, limit length)
                    const matchYear = text.match(/(\d{4})年/);
                    if (matchYear && text.length < 50) {
                        console.log(`【Debug】Date extraction: Header found year-only (${sel}): ${matchYear[1]}年`);
                        return matchYear[1];
                    }
                }
            }

            // Check 3: "Prev Month" button URL Link Analysis
            const prevBtn = document.querySelector('a.fc-button-prev, a.btn-prev, .previous_month a');
            if (prevBtn && prevBtn.href) {
                try {
                    const u = new URL(prevBtn.href, window.location.origin);
                    const py = u.searchParams.get('year');
                    const pm = u.searchParams.get('month');
                    if (py && pm) {
                        // Logic: Prev month is Y/M, so Current is Prev + 1 month
                        let y = parseInt(py, 10);
                        let m = parseInt(pm, 10);
                        m++;
                        if (m > 12) { m = 1; y++; }
                        console.log(`【Debug】Date extraction: Deduced from Prev Button link (${py}/${pm}) -> ${y}`);
                        return y.toString();
                    }
                } catch (e) { }
            }

            // Check 4: Table Content Inspection (YYYY/MM/DD)
            // Sometimes the first column has the full date
            const dateCells = document.querySelectorAll('td.date, td:first-child');
            for (let i = 0; i < Math.min(dateCells.length, 5); i++) {
                const txt = dateCells[i].innerText.trim();
                const match = txt.match(/^(\d{4})[\/／\-](\d{1,2})[\/／\-](\d{1,2})/); // 2024/01/01
                if (match) {
                    console.log(`【Debug】Date extraction: Found in table row: ${match[1]}`);
                    return match[1];
                }
            }

            // Check 5: Body Text Search (Brute Force / Last Resort)
            // Grab the first 3000 chars of visible text and look for "YYYY年MM月"
            const bodyTop = document.body.innerText.slice(0, 3000).replace(/\s+/g, '');
            const bodyMatch = bodyTop.match(/(\d{4})年(\d{1,2})月/);
            if (bodyMatch) {
                console.log(`【Debug】Date extraction: Found inside page text (brute force): ${bodyMatch[1]}年${bodyMatch[2]}月`);
                return bodyMatch[1];
            }

            // Fallback (Failed)
            const currentYear = new Date().getFullYear().toString();
            console.warn(`【Warning】Year could not be determined from page. Using current year: ${currentYear}`);
            console.log(`【Debug】Failed to find year. Checked URL, Headers, Buttons, Table, and Body text.`);
            return currentYear;
        };

        const scrapeFromElement = (element) => {
            const rows = element.querySelectorAll('tr');
            const data = [];

            // Get the year ONCE per page scrape to ensure consistency
            const pageYear = getYearFromPage();

            rows.forEach(row => {
                const getText = (cls) => row.querySelector(`.${cls}`)?.innerText.trim();
                const cells = row.querySelectorAll('td');

                let dateRaw = getText('date');
                let content = getText('content');
                let amountRaw = getText('amount');
                let source = getText('qt-financial_institution');
                let category = "";

                if ((!dateRaw || !content || !amountRaw) && cells.length >= 6) {
                    if (!dateRaw) dateRaw = cells[0]?.innerText.trim();
                    if (!content) content = cells[1]?.innerText.trim();
                    if (!amountRaw) amountRaw = cells[2]?.querySelector('span')?.innerText.trim() || cells[2]?.innerText.trim();
                }

                if (!source && cells.length > 4) {
                    source = cells[4]?.innerText.trim();
                }

                const catLarge = getText('qt-large_category') || (cells.length > 5 ? cells[5]?.innerText.trim() : "");
                const catMiddle = getText('qt-middle_category') || (cells.length > 6 ? cells[6]?.innerText.trim() : "");
                category = [catLarge, catMiddle].filter(c => c).join("/");

                if (dateRaw && content && amountRaw) {
                    let date = dateRaw;
                    // Normalize date: "01/01(Thu)" -> "YYYY/MM/DD"
                    const dateMatch = dateRaw.match(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/);
                    if (dateMatch) {
                        const m = dateMatch[1].padStart(2, '0');
                        const d = dateMatch[2].padStart(2, '0');
                        date = `${pageYear}/${m}/${d}`;
                    }

                    const amount = amountRaw.replace(/[,円\s]/g, '');
                    const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                    const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);

                    data.push({ ID: hashId, date, content, amount, source, category });
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
                syncSettings = JSON.parse(resConfig.responseText);
            } catch (e) {
                console.error("Invalid Response:", resConfig.responseText.slice(0, 500));
                if (resConfig.responseText.trim().startsWith('<')) {
                    throw new Error("GASがHTMLエラーを返しました。\nHTMLが返ってきているため、URL設定や認証を確認してください。");
                }
                throw new Error("GASからの応答が不正です (JSONパースエラー): " + e.message);
            }

            if (syncSettings.status === 'error') throw new Error(syncSettings.message);

            // 開始年月設定 (2021年10月まで)
            const TARGET_START_YEAR = 2021;
            const TARGET_START_MONTH = 10;
            const calculateMonthsToTarget = () => {
                const now = new Date();
                const currentYear = now.getFullYear();
                const currentMonth = now.getMonth() + 1;
                let diff = (currentYear - TARGET_START_YEAR) * 12 + (currentMonth - TARGET_START_MONTH) + 1;
                return Math.max(diff, 6);
            };

            const fullSyncMonths = calculateMonthsToTarget();
            const monthsToSync = (forceFull || syncSettings.mode === 'Full') ? fullSyncMonths : 6;

            showStatus(`モード: ${forceFull ? '強制Full' : syncSettings.mode} (${monthsToSync}ヶ月) で同期開始`);
            console.log(`【Debug】Syncing for ${monthsToSync} months.`);

            let allData = [];

            // 2. 複数月のデータをスクレイピング
            for (let i = 0; i < monthsToSync; i++) {
                showStatus(`データ取得中: ${i + 1} / ${monthsToSync} ヶ月目`);

                if (i > 0) await new Promise(r => setTimeout(r, 2000));

                // Get data from current page
                const data = scrapeCurrentPage();
                console.log(`Month ${i + 1}: ${data.length} items found.`);
                allData.push(...data);

                if (i < monthsToSync - 1) {
                    const prevButtons = [
                        'button.fc-button-prev',
                        '.fc-header-left .fc-button-prev',
                        '#bda-in-closing-month-asset a:first-child',
                        '.transaction_list .pagination .prev a',
                        'button.btn-prev-month',
                        'a.fc-button-prev',
                        'a.btn-prev',
                        '.previous_month',
                        '#menu_range_prev',
                        'a.btn[href*="month="]'
                    ];

                    let prevMonthButton = null;
                    for (const sel of prevButtons) {
                        const btn = document.querySelector(sel);
                        if (btn) {
                            prevMonthButton = btn;
                            console.log(`【Debug】Found prev button with selector: ${sel}`);
                            break;
                        }
                    }

                    if (prevMonthButton) {
                        try {
                            prevMonthButton.click();
                            await waitForElementToDisappear('#loading', '#loading-overlay', '.loading-spinner');
                            await new Promise(r => setTimeout(r, 1500));
                        } catch (err) {
                            console.warn("ページ遷移エラー", err);
                            break;
                        }
                    } else {
                        // URL Fallback
                        console.warn(`【Debug】Previous button not found. Attempting URL fallback.`);

                        const currentYearStr = getYearFromPage();
                        // Try to get month specifically for navigation math
                        let currentMonthStr = "";
                        const urlParams = new URLSearchParams(window.location.search);
                        if (urlParams.has('month')) {
                            currentMonthStr = urlParams.get('month');
                        } else {
                            // Try to extract just the month from DOM
                            const headerSelectors = ['.fc-header-title', 'h1', 'h2'];
                            for (const sel of headerSelectors) {
                                const el = document.querySelector(sel);
                                if (el) {
                                    const m = el.innerText.match(/(\d{1,2})月/);
                                    if (m) { currentMonthStr = m[1]; break; }
                                }
                            }
                        }

                        if (currentYearStr && currentMonthStr) {
                            let y = parseInt(currentYearStr, 10);
                            let m = parseInt(currentMonthStr, 10);

                            m--;
                            if (m < 1) { m = 12; y--; }

                            const nextUrl = new URL(window.location.href);
                            nextUrl.searchParams.set('year', y);
                            nextUrl.searchParams.set('month', m);
                            console.log(`【Debug】Navigating to: ${nextUrl.toString()}`);
                            window.location.href = nextUrl.toString();

                            await new Promise(r => setTimeout(r, 10000));
                        } else {
                            console.warn(`【Debug】Could not determine current date for URL fallback.`);
                            showStatus("エラー: 移動ボタンが見つからず、日付も特定できません", 5000, true);
                            diagnoseDOM();
                            break;
                        }
                    }
                }
            }

            const uniqueData = allData.filter((v, i, a) => a.findIndex(t => t.ID === v.ID) === i);
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

    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);
    GM_registerMenuCommand('強制フル同期 (2021/10〜)', () => {
        if (confirm("2021年10月まで遡って同期を実行しますか？\n(時間がかかります)")) {
            runSync(true);
        }
    });

    try {
        addStyles();
        showStatus("MF Sync: 待機中...");
        runSync();
    } catch (e) {
        console.error("Critical Error", e);
    }
})();