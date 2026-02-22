/**
 * sidepanel.js
 * Logic for the LinkedIn Email Harvester side panel
 */
// Fix 1: normalizeCommentText .co false positive resolved (content.js)
// Fix 2: buildDisplayList one-row-per-email enforced

// --- Constants ---
const STORAGE_KEY = 'harvesterResults';
const SESSION_WRITE_MAX_BYTES = 7_500_000;

// --- State ---
let results = [];
let disclosureAccepted = false;
let keepAliveInterval = null;
let scanStats = {
    commentsScanned: 0,
    emailsFound: 0,
    duplicatesRemoved: 0,
    repliesExpanded: 0
};
let isScanning = false;
let currentTabId = null;

// --- DOM Elements ---
const startBtn = document.getElementById('start-btn');
const startBtnLabel = startBtn && startBtn.querySelector('.btn-label');
const copyBtn = document.getElementById('copy-btn');
const downloadBtn = document.getElementById('download-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsDropdown = document.getElementById('settings-dropdown');
const themeBtn = document.getElementById('theme-btn');
const themeLabel = document.getElementById('theme-label');
const refreshBtn = document.getElementById('refresh-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const controlsStatus = document.getElementById('controls-status');
const resultsContainer = document.getElementById('results-container');
const resultsTableWrapper = document.getElementById('results-table-wrapper');
const resultsTable = document.getElementById('results-table');
const resultsBody = document.getElementById('results-body');
const resultsPlaceholder = document.getElementById('results-placeholder');
const warningBanner = document.getElementById('warning-banner');
const statsBar = document.getElementById('stats-bar');
const scanningView = document.getElementById('scanning-view');
const scanningPhase = document.getElementById('scanning-phase');
const scanningStatComments = document.getElementById('scanning-stat-comments');
const scanningStatEmails = document.getElementById('scanning-stat-emails');
const scanningLiveList = document.getElementById('scanning-live-list');
const scanningCoverageStats = document.getElementById('scanning-coverage-stats');
const completionBanner = document.getElementById('completion-banner');

// Toggles
const toggleReplies = document.getElementById('toggle-replies');
const toggleLoad = document.getElementById('toggle-load');
const toggleContext = document.getElementById('toggle-context');

// Stats (only Scanned and Emails shown to user)
const statScanned = document.getElementById('stat-scanned');
const statFound = document.getElementById('stat-found');

// Footer
const uniqueCount = document.getElementById('unique-count');
const extractTime = document.getElementById('extract-time');
const newScanBtn = document.getElementById('new-scan-btn');

// --- Modal (Privacy / Terms) ---
const MODAL_CONTENT = {
    privacy: {
        title: "Privacy Policy",
        html: `
<h3>Overview</h3>
<p>CommentMail extracts email addresses from LinkedIn post comments for legitimate professional use. Your privacy is the core principle.</p>
<h3>Data Collection</h3>
<p>CommentMail does not collect, transmit, store, or share any personal data with any external server or third party.</p>
<h3>What Stays on Your Device</h3>
<p>All extracted emails, names, and LinkedIn URLs exist only in your browser's session storage (chrome.storage.session). This data is automatically cleared when you close your browser.</p>
<h3>No External Servers</h3>
<p>CommentMail makes no requests to any server we operate. The only network activity is requests to LinkedIn's own servers using your existing logged-in session — identical to normal LinkedIn browsing.</p>
<h3>LinkedIn Data</h3>
<p>CommentMail reads publicly visible comment data from LinkedIn posts you navigate to while logged in. It does not access private messages, connection data, or anything not visible to you on screen.</p>
<h3>CSV Downloads</h3>
<p>CSV files are saved to your local machine only. We have no visibility into downloaded files.</p>
<h3>No Analytics</h3>
<p>CommentMail contains no analytics, tracking pixels, crash reporters, or telemetry of any kind.</p>
<h3>Contact</h3>
<p>Questions? Reach out via LinkedIn: <a href="https://www.linkedin.com/in/shailesh-entrant/" target="_blank" rel="noopener noreferrer">Shailesh Kumar</a></p>
<p class="modal-footer-note">Last updated: February 2026</p>
        `.trim()
    },
    terms: {
        title: "Terms of Use",
        html: `
<h3>Acceptance</h3>
<p>By using CommentMail, you agree to these terms.</p>
<h3>Permitted Use</h3>
<p>CommentMail is intended for legitimate professional use — for recruiters and hiring managers collecting contact information that LinkedIn users have voluntarily posted publicly in comment sections.</p>
<h3>Your Responsibility</h3>
<p>You are solely responsible for how you use extracted data. You agree to comply with applicable laws including GDPR and CAN-SPAM. Do not use extracted emails for spam, harassment, or any unlawful purpose.</p>
<h3>LinkedIn Compliance</h3>
<p>CommentMail reads only publicly visible data using your authenticated session. It does not bypass access controls or use LinkedIn's API in an unauthorized manner.</p>
<h3>No Warranty</h3>
<p>CommentMail is provided as-is. LinkedIn may change their interface at any time which may affect functionality. No guarantees of uptime or accuracy are made.</p>
<h3>Not Affiliated with LinkedIn</h3>
<p>CommentMail is an independent tool and is not affiliated with, endorsed by, or connected to LinkedIn Corporation in any way. LinkedIn is a trademark of LinkedIn Corporation.</p>
<p class="modal-footer-note">Last updated: February 2026</p>
        `.trim()
    }
};

function openModal(type) {
    const content = MODAL_CONTENT[type];
    if (!content) return;
    document.getElementById("modal-title").textContent = content.title;
    document.getElementById("modal-body").innerHTML = content.html;
    document.getElementById("modal-overlay").classList.remove("hidden");
}

function closeModal() {
    document.getElementById("modal-overlay").classList.add("hidden");
}

function isLinkedInPost(url) {
    if (!url) return false;
    return url.includes("linkedin.com/feed/update/") ||
        url.includes("linkedin.com/posts/") ||
        url.includes("linkedin.com/pulse/") ||
        /linkedin\.com\/in\/[^/]+\/recent-activity/.test(url);
}

/** Target size under quota so full payload fits (leave headroom). */
const SESSION_WRITE_TARGET_BYTES = 7_000_000;

async function safeSessionWrite(data) {
    try {
        let payload = { ...data };
        if (payload.harvesterResults && Array.isArray(payload.harvesterResults)) {
            let trimmed = payload.harvesterResults;
            let testPayload = { ...data, harvesterResults: trimmed };
            while (JSON.stringify(testPayload).length > SESSION_WRITE_TARGET_BYTES) {
                trimmed = trimmed.slice(-Math.floor(trimmed.length * 0.8));
                if (trimmed.length < 100) break;
                testPayload = { ...data, harvesterResults: trimmed };
            }
            payload = testPayload;
        }
        await chrome.storage.session.set(payload);
    } catch (e) {
        console.warn("[Harvester] Session write failed:", e.message);
    }
}

async function checkFirstRun() {
    const result = await chrome.storage.local.get("disclosureAccepted");
    disclosureAccepted = !!result.disclosureAccepted;
    if (!disclosureAccepted) {
        const overlay = document.getElementById("disclosure-overlay");
        const acceptBtn = document.getElementById("disclosure-accept");
        if (overlay) overlay.classList.remove("hidden");
        if (acceptBtn) {
            acceptBtn.addEventListener("click", async () => {
                await chrome.storage.local.set({ disclosureAccepted: true });
                disclosureAccepted = true;
                document.getElementById("disclosure-overlay").classList.add("hidden");
                checkCurrentTab();
            });
        }
    }
    return disclosureAccepted;
}

function startKeepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(async () => {
        try {
            await chrome.runtime.sendMessage({ action: "keepAlive" });
        } catch (e) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
            if (isScanning) {
                isScanning = false;
                document.body.classList.remove("scanning");
                if (startBtnLabel) startBtnLabel.textContent = "Start Scan";
                startBtn.classList.remove("stop");
                statusDot.classList.remove("active");
                statusText.textContent = "Extension was restarted. Results saved.";
                if (controlsStatus) controlsStatus.classList.remove('status-ready');
                await restoreSession();
                if (results.length > 0) {
                    resultsBody.innerHTML = '';
                    renderRows(buildDisplayList(results), 0);
                    updateFooter();
                    copyBtn.disabled = false;
                    downloadBtn.disabled = false;
                }
            }
        }
    }, 25000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await checkFirstRun();
    await restoreSession();
    await checkCurrentTab();

    // Event Listeners
    startBtn.addEventListener('click', toggleScan);
    copyBtn.addEventListener('click', copyAllEmails);
    downloadBtn.addEventListener('click', downloadCSV);

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !settingsDropdown.classList.contains('hidden');
        settingsDropdown.classList.toggle('hidden', open);
        settingsBtn.setAttribute('aria-expanded', !open);
    });
    document.addEventListener('click', () => {
        settingsDropdown.classList.add('hidden');
        settingsBtn.setAttribute('aria-expanded', 'false');
    });
    settingsDropdown.addEventListener('click', (e) => e.stopPropagation());

    themeBtn.addEventListener('click', () => {
        toggleTheme();
        settingsDropdown.classList.add('hidden');
        settingsBtn.setAttribute('aria-expanded', 'false');
    });
    refreshBtn.addEventListener('click', () => {
        if (confirm("Reset all results and start a new session?")) {
            resetScan();
        }
    });
    if (newScanBtn) newScanBtn.addEventListener('click', resetScan);

    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal-overlay").addEventListener("click", (e) => {
        if (e.target.id === "modal-overlay") closeModal();
    });
    document.getElementById("footer-privacy").addEventListener("click", () => openModal("privacy"));
    document.getElementById("footer-terms").addEventListener("click", () => openModal("terms"));

    chrome.runtime.onMessage.addListener(handleMessage);
});


// --- Logic ---

async function checkCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    currentTabId = tab.id;

    const isPost = isLinkedInPost(tab.url);

    if (!isPost) {
        warningBanner.classList.remove('hidden');
        startBtn.disabled = true;
        if (startBtnLabel) startBtnLabel.textContent = "Go to LinkedIn Post";
        statusText.textContent = "Not on a post • Open a post to scan";
        statusDot.className = "status-dot error";
        if (controlsStatus) controlsStatus.classList.remove('status-ready');
    } else {
        warningBanner.classList.add('hidden');
        startBtn.disabled = !disclosureAccepted;
        if (!isScanning) {
            if (startBtnLabel) startBtnLabel.textContent = "Start Scan";
            statusText.textContent = "Ready to Scan";
            statusDot.className = "status-dot";
            if (controlsStatus) controlsStatus.classList.add('status-ready');
            applyPhaseStyle("");
        }
    }
}

function isValidEmailRecord(r) {
    return r && typeof r === "object" && typeof r.email === "string" && r.email.trim().length > 0;
}

async function restoreSession() {
    try {
        const storage = await chrome.storage.session.get(STORAGE_KEY);
        const raw = storage[STORAGE_KEY];
        if (!Array.isArray(raw) || raw.length === 0) return;
        const valid = raw.filter(isValidEmailRecord);
        if (valid.length === 0) return;
        results = valid;
        renderTable(true);
        updateStats({ commentsScanned: 0, emailsFound: results.length });
        updateFooter();
    } catch (e) {
        console.warn("Failed to restore session:", e);
    }
}

async function toggleScan() {
    if (isScanning) {
        chrome.runtime.sendMessage({ action: "stopScan" });
        endScanState();
    } else {
        if (!disclosureAccepted) return;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        // Clear previous results if starting fresh? 
        // Usually user wants fresh scan.
        results = [];
        resultsBody.innerHTML = '';
        chrome.storage.session.remove(STORAGE_KEY); // Clear storage

        startScanState(tab.url);

        const response = await chrome.runtime.sendMessage({
            action: "startScan",
            tabId: tab.id,
            url: tab.url
        });

        if (response && response.error) {
            endScanState();
            statusText.textContent = "Error: " + response.error;
            statusDot.className = "status-dot error";
            if (controlsStatus) controlsStatus.classList.remove('status-ready');
        }
    }
}

function startScanState(postUrl) {
    isScanning = true;
    document.body.classList.add('scanning');
    if (startBtnLabel) startBtnLabel.textContent = "Stop Scan";
    startBtn.classList.add('stop');
    statusDot.classList.add('active');
    statusText.textContent = "Starting…";
    if (controlsStatus) controlsStatus.classList.remove('status-ready');
    applyPhaseStyle("");

    copyBtn.disabled = true;
    downloadBtn.disabled = true;

    scanningView.classList.remove('hidden');
    resultsContainer.classList.add('hidden');
    completionBanner.classList.add('hidden');
    const postUrlEl = document.getElementById('scanning-post-url');
    if (postUrlEl) postUrlEl.textContent = postUrl || '';
    updateScanningViewUI("Starting...", 0, 0, 0);
    updateScanningLiveFeed([]);
    startKeepAlive();
}

function endScanState(skipShowResults) {
    stopKeepAlive();
    const wasScanning = isScanning;
    isScanning = false;
    document.body.classList.remove('scanning');
    if (startBtnLabel) startBtnLabel.textContent = "Start Scan";
    startBtn.classList.remove('stop');
    statusDot.classList.remove('active');

    if (wasScanning && !skipShowResults) {
        showResultsView('stopped');
    }
    if (results.length > 0) {
        copyBtn.disabled = false;
        downloadBtn.disabled = false;
    }
}

function formatNum(n) {
    if (n == null || n === undefined) return '0';
    return Number(n).toLocaleString();
}

function updateScanningViewUI(phaseText, commentsScanned, totalComments, emailsFound) {
    if (scanningPhase) scanningPhase.textContent = phaseText || "Starting...";
    const totalCommentsVal = totalComments != null && totalComments > 0 ? totalComments : commentsScanned;
    if (scanningStatComments) scanningStatComments.textContent = formatNum(totalCommentsVal);
    if (scanningStatEmails) scanningStatEmails.textContent = formatNum(emailsFound);
}

function updateScanningLiveFeed(records) {
    const list = records || [];
    if (scanningLiveList) {
        scanningLiveList.innerHTML = '';
        const slice = list.slice(-4);
        slice.forEach(r => {
            const li = document.createElement('li');
            li.textContent = r.email;
            const author = document.createElement('span');
            author.className = 'author';
            author.textContent = r.authorName || 'Unknown';
            li.appendChild(author);
            scanningLiveList.appendChild(li);
        });
    }
    const labelEl = document.getElementById('scanning-live-feed-label');
    const placeholderEl = document.getElementById('scanning-live-placeholder');
    if (labelEl) labelEl.classList.toggle('hidden', list.length === 0);
    if (placeholderEl) placeholderEl.classList.toggle('hidden', list.length > 0);
}

function showResultsView(reason, stats, resultsOverride) {
    let list = resultsOverride != null ? resultsOverride : results;
    // Emergency fallback: if results empty, try session storage
    if (!list || list.length === 0) {
        chrome.storage.session.get("harvesterResults", (data) => {
            const fallback = data.harvesterResults || [];
            if (fallback.length > 0) {
                console.log("[Panel] Using session storage fallback:", fallback.length);
                list = fallback;
                results = fallback;
            }
            _renderResultsView(reason, stats, list);
        });
        return;
    }
    _renderResultsView(reason, stats, list);
}

function _renderResultsView(reason, stats, list) {
    scanningView.classList.add('fade-out');
    setTimeout(async () => {
        scanningView.classList.add('hidden');
        scanningView.classList.remove('fade-out');
        resultsContainer.classList.remove('hidden');
        resultsContainer.classList.add('results-just-shown');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                resultsContainer.classList.remove('results-just-shown');
            });
        });

        if (completionBanner) {
            completionBanner.classList.remove('hidden');
            const count = list.length;
            const comments = (stats && (stats.totalComments != null ? stats.totalComments : stats.commentsScanned)) || 0;
            if (reason === 'complete') {
                completionBanner.textContent = `✓ Scan complete — ${formatNum(count)} unique emails from ${formatNum(comments)} comments`;
                completionBanner.classList.remove('stopped');
                completionBanner.classList.add('complete');
            } else {
                completionBanner.textContent = `◼ Scan stopped — ${formatNum(count)} emails found so far`;
                completionBanner.classList.remove('complete');
                completionBanner.classList.add('stopped');
            }
        }

        resultsBody.innerHTML = '';
        if (list.length > 0) {
            resultsTableWrapper.classList.remove('hidden');
            resultsPlaceholder.classList.add('hidden');
            renderRows(buildDisplayList(list), 0);
        } else {
            resultsTableWrapper.classList.add('hidden');
            resultsPlaceholder.classList.remove('hidden');
        }
        updateFooter();
        if (stats) updateStats(stats);

        safeSessionWrite({
            harvesterResults: list,
            harvesterStats: stats || {},
            harvesterTimestamp: Date.now()
        });
    }, 200);
}

function handleMessage(message, sender, sendResponse) {
    if (message.action === "progressUpdate") {
        const st = message.stats || {};
        if (message.newRecords && message.newRecords.length > 0) {
            accumulateResults(message.newRecords);
        }
        if (message.partialResults && message.partialResults.length > 0) {
            accumulateResults(message.partialResults);
        }
        if (message.totalCount === 0) {
            results = [];
        }
        if (st.currentPhase != null) {
            statusText.textContent = st.currentPhase;
            if (controlsStatus) controlsStatus.classList.remove('status-ready');
            applyPhaseStyle(st.currentPhase);
        }
        if (isScanning && scanningView && !scanningView.classList.contains('hidden')) {
            const comments = st.commentsScanned ?? 0;
            const total = st.totalComments ?? 0;
            // Use totalCount from content (emailMap size) so the number always matches actual extracted emails
            const emails = message.totalCount ?? st.emailsFound ?? results.length;
            updateScanningViewUI(
                st.currentPhase || "Processing...",
                comments,
                total,
                emails
            );
            if (uniqueCount && (message.totalCount !== undefined || results.length > 0)) {
                const n = message.totalCount ?? results.length;
                uniqueCount.textContent = n === 1 ? "1 email" : `${formatNum(n)} emails`;
            }
            if (scanningCoverageStats) {
                const api = st.apiEmailsCount ?? 0;
                const dom = st.domEmailsCount ?? 0;
                const reply = st.replyEmailsCount ?? 0;
                const failed = st.failedPages ?? 0;
                scanningCoverageStats.textContent = `API: ${api} · DOM: ${dom} · Replies: ${reply} · Failed: ${failed}`;
            }
            updateScanningLiveFeed(results);
        }
        if (!isScanning) {
            updateStats(st);
            if (message.totalCount !== undefined) {
                const n = message.totalCount;
                uniqueCount.textContent = n === 1 ? "1 email" : `${n} emails`;
            }
        }
    } else if (message.action === "syncResults") {
        if (message.results && Array.isArray(message.results)) {
            results = message.results;
            if (isScanning) {
                updateScanningLiveFeed(results);
                if (scanningStatEmails) scanningStatEmails.textContent = formatNum(results.length);
                if (uniqueCount) uniqueCount.textContent = results.length === 1 ? "1 email" : `${formatNum(results.length)} emails`;
            } else {
                resultsBody.innerHTML = '';
                renderRows(buildDisplayList(results), 0);
                updateFooter();
            }
        }
    } else if (message.action === "scanComplete") {
        // FIX BUG 1: use accumulated results from progressUpdate — don't rely on getResults roundtrip
        console.log("[Panel] scanComplete received");
        console.log("[Panel] accumulated results length:", results?.length);

        statusText.textContent = message.errorMessage === "rate_limited"
            ? "Rate limited — try again later"
            : "Scan complete";
        if (controlsStatus) controlsStatus.classList.remove('status-ready');

        const finalResults = (results && results.length > 0) ? results : [];
        console.log("[Panel] Rendering with", finalResults.length, "results");
        results = finalResults;
        showResultsView(message.errorMessage ? 'stopped' : 'complete', message.stats, finalResults);

        safeSessionWrite({
            harvesterResults: finalResults,
            harvesterStats: message.stats || {},
            harvesterTimestamp: Date.now()
        });
        endScanState(true);
    }
}

function applyPhaseStyle(currentPhase) {
    const statusEl = document.getElementById("controls-status");
    if (!statusEl) return;
    statusEl.classList.remove("phase-parsing", "phase-fallback");
    if (currentPhase === "Parsing responses") {
        statusEl.classList.add("phase-parsing");
    } else if (currentPhase === "Scanning (DOM fallback)") {
        statusEl.classList.add("phase-fallback");
    }
}

function updateStats(stats) {
    const comments = (stats && (stats.totalComments != null ? stats.totalComments : stats.commentsScanned)) ?? 0;
    const emails = (stats && stats.emailsFound != null) ? stats.emailsFound : 0;
    if (statScanned) statScanned.textContent = formatNum(comments);
    if (statFound) statFound.textContent = formatNum(emails);
}

// --- FIX 6: SESSION STORAGE FIX ---
/** During scan: accumulate only (no table render). No session write here — single write when scan completes/stops. */
function accumulateResults(newRecords) {
    if (!newRecords || newRecords.length === 0) return;
    results.push(...newRecords);
}

function addResults(newRecords) {
    if (!newRecords || newRecords.length === 0) return;
    const wasEmpty = results.length === 0;
    results.push(...newRecords);

    if (wasEmpty && results.length > 0) {
        if (resultsTableWrapper) resultsTableWrapper.classList.remove('hidden');
        if (resultsPlaceholder) resultsPlaceholder.classList.add('hidden');
    }

    const fragment = document.createDocumentFragment();

    newRecords.forEach((record, index) => {
        // index in total array = old length + current index
        // We display # as 1-indexed
        const num = results.length - newRecords.length + index + 1;

        const tr = document.createElement('tr');

        // #
        const tdNum = document.createElement('td');
        tdNum.textContent = num;
        tr.appendChild(tdNum);

        // Email
        const tdEmail = document.createElement('td');
        tdEmail.className = 'email-cell';
        tdEmail.textContent = record.email;
        tr.appendChild(tdEmail);

        // Author (full name; tooltip if long)
        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'author-cell';
        tdAuthor.textContent = record.authorName || "Unknown";
        if (record.authorName) tdAuthor.title = record.authorName;
        tr.appendChild(tdAuthor);

        // Source (comment / reply / fallback)
        const tdSource = document.createElement('td');
        tdSource.className = 'source-cell';
        const st = (record.sourceType || 'comment').toLowerCase();
        tdSource.textContent = st === 'reply' ? 'Reply' : st === 'comment' ? 'Comment' : 'Other';
        tr.appendChild(tdSource);

        // Title (headline)
        const tdTitle = document.createElement('td');
        tdTitle.textContent = record.authorTitle || "-";
        if ((record.authorTitle || "").length > 25) tdTitle.title = record.authorTitle;
        tdTitle.style.maxWidth = '140px';
        tdTitle.style.overflow = 'hidden';
        tdTitle.style.textOverflow = 'ellipsis';
        tdTitle.className = 'title-cell';
        tr.appendChild(tdTitle);

        // Profile
        const tdProf = document.createElement('td');
        if (record.linkedinProfileUrl) {
            const a = document.createElement('a');
            a.href = record.linkedinProfileUrl;
            a.target = '_blank';
            a.textContent = 'LINK';
            a.className = 'btn-secondary'; // re-use style or just specific
            a.style.padding = '2px 6px';
            a.style.fontSize = '10px';
            tdProf.appendChild(a);
        } else {
            tdProf.textContent = '-';
        }
        tr.appendChild(tdProf);

        // Action
        const tdAction = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'action-btn';
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        btn.title = "Copy Email";
        const defaultHtml = btn.innerHTML;
        btn.onclick = () => {
            navigator.clipboard.writeText(record.email);
            btn.textContent = 'Copied!';
            btn.style.minWidth = btn.offsetWidth + 'px';
            setTimeout(() => { btn.innerHTML = defaultHtml; btn.style.minWidth = ''; }, 2000);
        };
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);

        fragment.appendChild(tr);
    });

    resultsBody.appendChild(fragment);
    updateFooter();
}

/**
 * Handle full table re-render (restore)
 */
function renderTable(clear = true) {
    if (clear) resultsBody.innerHTML = '';
    if (results.length === 0) {
        resultsTableWrapper.classList.add('hidden');
        resultsPlaceholder.classList.remove('hidden');
        return;
    }
    resultsTableWrapper.classList.remove('hidden');
    resultsPlaceholder.classList.add('hidden');
    renderRows(buildDisplayList(results), 0);
}

// Correction for renderTable logic if we reuse addResults:
// addResults updates persistence and pushes to array.
// For restore, we just want to render. 
// I will not implement a separate complex render for restore, I'll just clear results array before calling addResults in restore.
// Wait, restoreSession sets results from storage. 
// So I should clear results array before calling addResults, because addResults will push them back.
// In restoreSession:
// results = storage[...];
// addResults(results) -> pushes again -> double results. 
// Fix:
// In restoreSession, I shouldn't set global results directly if I use addResults.
// Or I create a `renderRows` helper separate from `addResults`.

function isValidEmailDisplay(email) {
    if (!email || !email.includes("@")) return false;
    const domain = email.split("@")[1] || "";
    return domain.includes(".");
}

function buildDisplayList(records) {
    if (!records || records.length === 0) return [];
    return records
        .filter(r => isValidEmailDisplay(r.email))
        .sort((a, b) => {
            const nameCompare = (a.authorName || "")
                .localeCompare(b.authorName || "");
            if (nameCompare !== 0) return nameCompare;
            return (a.email || "").localeCompare(b.email || "");
        });
}

function renderRows(records, startIndex) {
    const fragment = document.createDocumentFragment();
    records.forEach((record, index) => {
        const num = startIndex + index + 1;
        const tr = document.createElement('tr');

        const tdNum = document.createElement('td');
        tdNum.textContent = num;
        tr.appendChild(tdNum);

        const tdEmail = document.createElement('td');
        tdEmail.className = 'email-cell';
        tdEmail.textContent = record.email;
        tr.appendChild(tdEmail);

        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'author-cell';
        tdAuthor.textContent = record.authorName || "Unknown";
        if (record.authorName) tdAuthor.title = record.authorName;
        tr.appendChild(tdAuthor);

        const tdSource = document.createElement('td');
        tdSource.className = 'source-cell';
        const st = (record.sourceType || 'comment').toLowerCase();
        tdSource.textContent = st === 'reply' ? 'Reply' : st === 'comment' ? 'Comment' : 'Other';
        tr.appendChild(tdSource);

        const tdTitle = document.createElement('td');
        tdTitle.className = 'title-cell';
        tdTitle.textContent = record.authorTitle || "-";
        if (record.authorTitle) tdTitle.title = record.authorTitle;
        tr.appendChild(tdTitle);

        const tdProf = document.createElement('td');
        if (record.linkedinProfileUrl) {
            const a = document.createElement('a');
            a.href = record.linkedinProfileUrl;
            a.target = '_blank';
            a.textContent = 'LINK';
            a.style.textDecoration = 'none';
            a.style.color = 'var(--accent)';
            tdProf.appendChild(a);
        } else {
            tdProf.textContent = '-';
        }
        tr.appendChild(tdProf);

        const tdAction = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'action-btn';
        btn.innerHTML = '📋';
        btn.title = 'Copy Email' + (record.allEmails ? ' (all variants)' : '');
        const defaultLabel = '📋';
        const textToCopy = record.allEmails ? record.allEmails.join(', ') : record.email;
        btn.onclick = () => {
            navigator.clipboard.writeText(textToCopy);
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = defaultLabel; }, 2000);
        };
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);

        fragment.appendChild(tr);
    });
    resultsBody.appendChild(fragment);
}
// Overwriting addResults to be cleaner with the above fix logic: 
// But since I can't go back and edit the tool call content easily in thought process, I will stick to what I wrote in the main code block below
// and ensure `addResults` functions correctly.
// The code below handles it.

function updateFooter() {
    uniqueCount.textContent = results.length === 1 ? "1 email" : `${results.length} emails`;
    if (results.length > 0) {
        copyBtn.disabled = false;
        downloadBtn.disabled = false;
    }
}

function copyAllEmails() {
    const text = results.map(r => r.email).join('\n');
    navigator.clipboard.writeText(text);

    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => copyBtn.textContent = original, 2000);
}

function downloadCSV() {
    if (results.length === 0) return;

    // Column order: Serial Number, Full Name, Author Title, Email, LinkedIn Profile URL, Comment Snippet, Source Type, Post URL, Extracted At, Seen Count
    const headers = [
      "serial_number",
      "full_name",
      "author_title",
      "email",
      "linkedin_profile_url",
      "comment_snippet",
      "source_type",
      "post_url",
      "extracted_at_iso",
      "seen_count"
    ];

    const rows = results.map((r, index) => {
      const row = [
        index + 1,
        q(csvSafeField(r.authorName || "Unknown")),
        q(csvSafeField(r.authorTitle || "")),
        q(csvSafeField(r.email)),
        q(csvSafeField(r.linkedinProfileUrl || "")),
        q(csvSafeField(r.commentSnippet ?? "")),
        q(csvSafeField(r.sourceType ?? "comment")),
        q(csvSafeField(r.postUrl || "")),
        q(csvSafeField(r.extractedAtISO || "")),
        csvSafeField(String(r.seenCount ?? 1))
      ];
      return row.join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const filename = `linkedin-emails-${Date.now()}.csv`;

    chrome.runtime.sendMessage({
        action: "downloadCSV",
        csvContent: csvContent,
        filename: filename
    });
}

function q(str) {
    if (str === null || str === undefined) return '""';
    if (typeof str === 'string') {
        return `"${str.replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    }
    return str;
}

/** Prevents CSV formula injection (Excel/Sheets): prefix formula-starting chars with single quote. */
function csvSafeField(value) {
    const str = String(value ?? "");
    if (["=", "+", "-", "@", "\t", "\r"].includes(str[0])) return `'${str}`;
    return str;
}

// --- UI Helpers ---

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.body.dataset.theme = savedTheme;
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentmode = document.body.dataset.theme || 'dark';
    const newMode = currentmode === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = newMode;
    localStorage.setItem('theme', newMode);
    updateThemeIcon(newMode);
}

function updateThemeIcon(mode) {
    if (themeLabel) themeLabel.textContent = mode === 'dark' ? 'Dark' : 'Light';
}

function resetScan() {
    if (isScanning) {
        chrome.runtime.sendMessage({ action: "stopScan" });
        endScanState(true);
    }

    results = [];
    resultsBody.innerHTML = '';
    chrome.storage.session.remove(STORAGE_KEY);

    document.body.classList.remove('scanning');
    if (scanningView) scanningView.classList.add('hidden');
    if (resultsContainer) resultsContainer.classList.remove('hidden');
    if (completionBanner) completionBanner.classList.add('hidden');
    resultsTableWrapper.classList.add('hidden');
    resultsPlaceholder.classList.remove('hidden');

    updateStats({
        commentsScanned: 0,
        emailsFound: 0,
        duplicatesRemoved: 0,
        repliesExpanded: 0,
        interceptedRequests: 0
    });
    uniqueCount.textContent = "0 emails";
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    statusText.textContent = "Ready to Scan";
    statusDot.className = "status-dot";
    if (controlsStatus) controlsStatus.classList.add('status-ready');
    applyPhaseStyle("");
    checkCurrentTab();
}
