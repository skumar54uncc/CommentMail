// Fixed: [4], [5]
// Fix 1: normalizeCommentText .co false positive resolved
// Fix 2: buildDisplayList one-row-per-email enforced (sidepanel.js)
/*
 * content.js - LinkedIn Email Comment Extractor
 * WORLD-CLASS ARCHITECTURE v3.0
 * CWS Compliance: v1.0 — Disclosure, URL patterns, locale-safe, rate-limit protection, absolute timeout, keepalive
 *
 * Interception: MAIN world injector only (debugger removed)
 * Replay: AIMD adaptive concurrency (2-10 pages/batch)
 * Replies: Queued replay, max 3 concurrent, threshold-gated
 * Progress: MutationObserver + intercept signals (no polling)
 * Stop: Quiet-window heuristic (2500ms all-signals-idle)
 * Dedupe: LRU cache, strong body-fingerprint keys
 * Fallback: Coverage-aware (enrichment-only when API > 90%)
 * Metrics: apiCount, domCount, replyCount, failedPages
 */

// --- Constants ---
const LOAD_MORE_WAIT_MS = 1200;
const REPLY_EXPAND_WAIT_MS = 1000;
const SEE_MORE_WAIT_MS = 60;
const CLICK_JITTER_MS = 20;
const MAX_LOAD_MORE_CLICKS = 5000;
const MAX_REPLY_CLICKS = 8000;
const INTERCEPT_FALLBACK_TIMEOUT_MS = 15000;
const SCROLL_COMMENTS_EVERY_N_CLICKS = 4;
const MAX_SCAN_PASSES = 40;
const NO_BUTTON_ROUNDS_BEFORE_GIVE_UP = 4;
const NO_NEW_COMMENTS_PASSES_BEFORE_GIVE_UP = 4;
const LARGE_THREAD_PASSES_BEFORE_GIVE_UP = 6;
const NO_WORK_PASSES_BEFORE_EXIT = 2;

const BATCH_DELAY_MS = 150;
const FIRST_INTERCEPT_TIMEOUT_MS = 5000;
const REPLY_CLICK_BATCH_SIZE = 15;
const PROGRESS_THROTTLE_MS = 400;
const WAIT_FOR_PROGRESS_POLL_MS = 60;
const QUIET_WINDOW_MS = 2500;
const API_COVERAGE_THRESHOLD = 0.90;
/** Base timeout: 20 min so large threads (4k+ comments) can finish. */
const ABSOLUTE_SCAN_TIMEOUT_MS = 20 * 60 * 1000;
/** Cap: extend-on-progress never exceeds this from scan start. */
const MAX_ABSOLUTE_SCAN_TIMEOUT_MS = 35 * 60 * 1000;
/** When we extend on progress, add this much (up to cap). */
const EXTEND_ON_PROGRESS_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_REPLY_REPLAYS = 3;
const MIN_REPLY_REPLAY_THRESHOLD = 10;

const CONFIG = {
    LOAD_MORE_WAIT_MS,
    REPLY_EXPAND_WAIT_MS,
    SEE_MORE_WAIT_MS,
    CLICK_JITTER_MS,
    MAX_LOAD_MORE_CLICKS,
    MAX_REPLY_CLICKS,
    MAX_EMAILS: 10000,
    IDLE_TIMEOUT_MS: 45000,
    DOM_FALLBACK_DELAY_MS: INTERCEPT_FALLBACK_TIMEOUT_MS
};

// --- State ---
let isScanning = false;
let injectorReady = false;
let processedCommentIds = new Set();
let emailMap = new Map();
let clickedReplyButtons = new WeakSet();
let lastProgressSent = 0;
let lastSyncedCount = 0;           // --- DELTA SYNC ---

// Absolute timeout: can be extended while scan is making progress (up to MAX_ABSOLUTE_SCAN_TIMEOUT_MS)
let absoluteTimeoutId = null;
let absoluteDeadlineMs = 0;        // total ms from scan start we're allowed
let scanStartTimeForTimeout = 0;
let lastExtendedCount = 0;

// First payload arrived (so we can await replay or run click loop)
let firstInterceptResolve = null;
let replayEngineStarted = false;  // --- REQUEST REPLAY ENGINE ---
let replayCompletePromise = null;
let lastInterceptTimestamp = 0;
let enrichmentSyncIntervalId = null;  // run enrichment during scan and sync to side panel for live feed names

let scanStats = {
    commentsScanned: 0,
    emailsFound: 0,
    duplicatesRemoved: 0,
    repliesExpanded: 0,
    currentPhase: "Idle",
    interceptedRequests: 0,
    apiEmailsCount: 0,
    domEmailsCount: 0,
    replyEmailsCount: 0,
    failedPages: 0
};

let replayTotalPages = 0;
let domProgressCounter = 0;
let lastDomChangeTimestamp = 0;
let commentMutationObserver = null;
let mutationDebounceTimer = null;
let replyReplayQueue = [];
let activeReplyReplays = 0;
let bufferPollInterval = null;

const replayController = {
    concurrency: 6,
    minConcurrency: 2,
    maxConcurrency: 10,
    rateLimitHits: 0,
    consecutiveRateLimits: 0,
    onSuccess() {
        if (this.concurrency < this.maxConcurrency) {
            this.concurrency = Math.min(this.maxConcurrency, (this.concurrency + 0.5) | 0 || 1);
        }
        this.rateLimitHits = 0;
        this.consecutiveRateLimits = 0;
    },
    onRateLimit() {
        this.consecutiveRateLimits++;
        this.rateLimitHits++;
        this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
        if (this.consecutiveRateLimits >= 5) return "account_limited";
        return this.rateLimitHits >= 3 ? "pause" : "backoff";
    },
    reset() {
        this.concurrency = 6;
        this.rateLimitHits = 0;
        this.consecutiveRateLimits = 0;
    }
};

class LRUCache {
    constructor(maxSize = 5000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    has(key) {
        if (!this.cache.has(key)) return false;
        const val = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, val);
        return true;
    }
    add(key) {
        if (this.cache.size >= this.maxSize) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, true);
    }
    clear() { this.cache.clear(); }
}

function fnv32a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
}

function getPayloadKey(url, payload, bodyStr) {
    bodyStr = bodyStr || "";
    let urlBase = (url || "").split("?")[0];
    let start = "0";
    try {
        const params = new URL(url || "", window.location.origin).searchParams;
        start = params.get("start") || "0";
    } catch (e) {}
    const total = payload?.paging?.total ?? payload?.data?.paging?.total ?? "?";
    const len = bodyStr.length;
    const sample = bodyStr.substring(0, 64) +
        (len > 128 ? bodyStr.substring(Math.floor(len / 2) - 32, Math.floor(len / 2) + 32) : "") +
        (len > 64 ? bodyStr.substring(len - 64) : "");
    const hash = fnv32a(sample);
    return `${urlBase}|${start}|${total}|${hash}`;
}

function isLinkedInPost(url) {
    if (!url) return false;
    return url.includes("linkedin.com/feed/update/") ||
        url.includes("linkedin.com/posts/") ||
        url.includes("linkedin.com/pulse/") ||
        /linkedin\.com\/in\/[^/]+\/recent-activity/.test(url);
}

// -- Module 1: Injector Bootstrapper --
if (window.__harvesterContentInjected) {
    // Already active; no-op
} else {
    window.__harvesterContentInjected = true;
    window.addEventListener("message", handleInjectorMessage);
    showToast("CommentMail Ready");
}

let harvesterExpectedNonce = null;
let scanStartTimestamp = null;
let harvesterCsrfToken = null;

function handleInjectorMessage(event) {
    if (event.source !== window) return;
    const type = event.data?.type;
    if (harvesterExpectedNonce != null && event.data?.nonce !== harvesterExpectedNonce) return;
    if (type === "__HARVESTER_READY__") {
        injectorReady = true;
        return;
    }
    if (type !== "__HARVESTER_INTERCEPT__") return;
    if (!isScanning) return;
    injectorReady = true;

    const url = event.data?.url;
    const payload = event.data?.payload;
    if (!url || !payload) return;
    if (event.data?.csrfToken) harvesterCsrfToken = event.data.csrfToken;
    if (url.includes("/comments") || url.includes("social-actions") || url.includes("/feed/updates") || url.includes("graphql")) {
        parseInterceptedPayload(payload, url, event.data?.bodySample);
    }
}


// --- Chrome Runtime Listeners ---
// --- Chrome Runtime Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        if (message.action === "startScan") {
            if (isScanning) {
                sendResponse({ status: "already_scanning" });
                return;
            }
            harvesterExpectedNonce = message.nonce || null;
            // Execute async but don't await here (keep channel open if needed, but we use fire-and-forget for start)
            startScan().catch(e => {
                console.error("[Harvester] Critical Error in startScan:", e);
                updatePhase("Error: " + e.message);
            });
            sendResponse({ status: "started" });
        } else if (message.action === "ping") {
            sendResponse({ status: "pong" });
        } else if (message.action === "stopScan") {
            stopScan();
            sendResponse({ status: "stopped" });
        } else if (message.action === "getResults") {
            const results = getValidResults();
            sendResponse({ results: results });
        } else if (message.action === "interceptedPayload") {
            if (isScanning && message.payload && message.url) {
                const url = message.url;
                if (url.includes("/comments") || url.includes("social-actions") || url.includes("/feed/updates") || url.includes("graphql")) {
                    parseInterceptedPayload(message.payload, url);
                }
            }
            return;
        }
    } catch (e) {
        console.error("[Harvester] Runtime listener error:", e);
        sendResponse({ status: "error", message: e.message });
    }
});


// --- Module 2: The Scanner Orchestrator ---

function handleVisibilityChange() {
    if (document.hidden && isScanning) {
        updatePhase((scanStats.currentPhase || "Scanning") + " (tab in background — keep tab active for best results)");
    }
}

async function startScan() {
    if (!isLinkedInPost(window.location.href)) {
        updatePhase("Not a post page • Open a post to scan");
        return;
    }
    isScanning = true;
    resetState();
    scanStartTimestamp = new Date().toISOString();

    const postState = detectPostState();
    if (postState.state !== "ok") {
        isScanning = false;
        updatePhase(postState.message);
        chrome.runtime.sendMessage({ action: "scanComplete", stats: scanStats, errorMessage: postState.message }).catch(() => {});
        return;
    }

    scanStartTimeForTimeout = Date.now();
    absoluteDeadlineMs = ABSOLUTE_SCAN_TIMEOUT_MS;
    lastExtendedCount = 0;
    scheduleAbsoluteTimeout();

    startDomObserver();
    startBufferPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    injectorReady = false;
    window.postMessage({ type: "__HARVESTER_PING__" }, "*");
    await wait(150);

    await switchToMostRecentComments();
    await verifySortOrder();

    updatePhase("Starting...");
    sendProgressThrottled();

    const commentsArea = document.querySelector(".comments-comments-list, [class*='comments-list'], .social-details-social-activity");
    if (commentsArea) {
        commentsArea.scrollIntoView({ behavior: "smooth", block: "start" });
        await wait(800);
    }

    const totalCount = extractTotalCommentCount();
    if (totalCount > 0) scanStats.totalComments = totalCount;

    const activityCheck = setTimeout(() => {
        if (!isScanning || scanStats.interceptedRequests > 0) return;
        if (!injectorReady) {
            updatePhase("Interceptor missing — refresh tab");
        } else {
            updatePhase("Scanning (DOM fallback)");
        }
        fallbackDomScan();
    }, INTERCEPT_FALLBACK_TIMEOUT_MS);

    startEnrichmentSyncInterval();

    try {
        updatePhase("Expanding text...");
        await clickSeeMoreButtons();

        const loadMoreBtn = findLoadMoreButton();
        if (loadMoreBtn) {
            loadMoreBtn.scrollIntoView({ behavior: "auto", block: "center" });
            await wait(150);
            loadMoreBtn.click();
        }

        const firstInterceptPromise = new Promise((resolve) => {
            firstInterceptResolve = resolve;
        });
        await Promise.race([
            firstInterceptPromise,
            wait(FIRST_INTERCEPT_TIMEOUT_MS)
        ]);

        if (replayEngineStarted && replayCompletePromise) {
            await replayCompletePromise;
        } else {
            const requiredNoNewPasses = (scanStats.totalComments || 0) > 2000 ? LARGE_THREAD_PASSES_BEFORE_GIVE_UP : NO_NEW_COMMENTS_PASSES_BEFORE_GIVE_UP;
            let noNewCommentsPasses = 0;
            let noWorkPasses = 0;  // both load-more and reply loops did nothing → exit soon
            for (let pass = 0; pass < MAX_SCAN_PASSES && isScanning; pass++) {
                updatePhase(`Loading comments (pass ${pass + 1}/${MAX_SCAN_PASSES})…`);
                const loadMoreBefore = countCommentElements();
                await scrollCommentsAndPageToBottom();
                const { loadClicks, exitedBecauseNoButton } = await loadMoreCommentsLoop();
                updatePhase("Expanding replies…");
                const { replyClicks } = await expandRepliesLoop();
                const loadMoreAfter = countCommentElements();
                sendProgressThrottled();

                // Early exit: nothing to load and no reply buttons = we're done
                if (loadClicks === 0 && exitedBecauseNoButton && replyClicks === 0) {
                    noWorkPasses++;
                    if (noWorkPasses >= NO_WORK_PASSES_BEFORE_EXIT) {
                        console.log("[Harvester] No load-more or reply buttons for 2 passes — exiting multi-pass early");
                        break;
                    }
                    await scrollCommentsAndPageToBottom();
                    await wait(150);
                    continue;
                }
                noWorkPasses = 0;

                if (loadMoreAfter <= loadMoreBefore) {
                    noNewCommentsPasses++;
                    if (noNewCommentsPasses >= requiredNoNewPasses) break;
                    await scrollCommentsAndPageToBottom();
                    await wait(150);
                } else {
                    noNewCommentsPasses = 0;
                }
            }
        }

        updatePhase("Expanding replies…");
        await expandRepliesLoop();

        await waitForQuietWindow();
        clearTimeout(activityCheck);

        const totalPagingKnown = replayTotalPages > 0;
        const apiCoverage = totalPagingKnown ? (scanStats.interceptedRequests / replayTotalPages) : 0;

        if (scanStats.interceptedRequests > 0 && emailMap.size > 0) {
            console.log("[Harvester] Skipping DOM extraction — API sufficient");
            updatePhase("Enriching names…");
            enrichUnknownAuthorsFromDom();
        } else if (apiCoverage >= API_COVERAGE_THRESHOLD) {
            console.log("[Harvester] API coverage " + (apiCoverage * 100).toFixed(0) + "% — DOM enrichment only");
            updatePhase("Enriching names…");
            enrichUnknownAuthorsFromDom();
        } else {
            console.log("[Harvester] API coverage " + (apiCoverage * 100).toFixed(0) + "% — running full DOM fallback");
            if (scanStats.interceptedRequests === 0 || emailMap.size === 0) updatePhase("DOM Fallback Scan");
            else updatePhase("Final DOM pass…");
            fallbackDomScan();
            enrichUnknownAuthorsFromDom();
        }

        sendProgressThrottled();

        // FIX BUG 2: diagnostic logging before scan complete
        const avgEmailsPerComment = emailMap.size / Math.max(scanStats.commentsScanned, 1);
        console.log("[Harvester] SCAN SUMMARY:");
        console.log("  emailMap.size:", emailMap.size);
        console.log("  commentsScanned:", scanStats.commentsScanned);
        console.log("  avg emails per comment:", avgEmailsPerComment.toFixed(2));
        console.log("  interceptedRequests:", scanStats.interceptedRequests);
        console.log("  apiEmailsCount:", scanStats.apiEmailsCount);
        console.log("  domEmailsCount:", scanStats.domEmailsCount);

        removeFragmentEmailsFromMap();
        updatePhase("Complete");
        sendScanComplete();

    } catch (e) {
        console.error("[Harvester] Scan error:", e);
        updatePhase("Error: " + e.message);
    } finally {
        isScanning = false;
        clearTimeout(activityCheck);
        if (absoluteTimeoutId) {
            clearTimeout(absoluteTimeoutId);
            absoluteTimeoutId = null;
        }
        stopDomObserver();
        stopBufferPolling();
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        clearEnrichmentSyncInterval();
    }
}

function stopScan() {
    isScanning = false;
    clearEnrichmentSyncInterval();
    updatePhase("Stopped by user");
}

function resetState() {
    harvesterExpectedNonce = null;
    scanStartTimestamp = null;
    harvesterCsrfToken = null;
    processedCommentIds.clear();
    emailMap.clear();
    clickedReplyButtons = new WeakSet();
    seenPayloadKeys.clear();
    replayedReplyUrns.clear();
    replyReplayQueue.length = 0;
    activeReplyReplays = 0;
    firstInterceptResolve = null;
    replayEngineStarted = false;
    replayCompletePromise = null;
    lastSyncedCount = 0;
    if (absoluteTimeoutId) {
        clearTimeout(absoluteTimeoutId);
        absoluteTimeoutId = null;
    }
    absoluteDeadlineMs = 0;
    scanStartTimeForTimeout = 0;
    lastExtendedCount = 0;
    replayController.reset();
    replayTotalPages = 0;
    domProgressCounter = 0;
    lastDomChangeTimestamp = 0;
    stopDomObserver();
    scanStats = {
        commentsScanned: 0,
        emailsFound: 0,
        duplicatesRemoved: 0,
        repliesExpanded: 0,
        currentPhase: "Starting...",
        interceptedRequests: 0,
        apiEmailsCount: 0,
        domEmailsCount: 0,
        replyEmailsCount: 0,
        failedPages: 0
    };
    sendProgressThrottled();
}

// --- FIX 1: REPLY REPLAY ENGINE ---
const replayedReplyUrns = new Set();

// --- REQUEST REPLAY ENGINE ---
const requestBudget = {
    topLevel: { maxPerWindow: 15, windowMs: 10000, count: 0, windowStart: Date.now() },
    reply: { maxPerWindow: 8, windowMs: 10000, count: 0, windowStart: Date.now() },
    async consume(type) {
        const budget = this[type];
        const now = Date.now();
        if (now - budget.windowStart > budget.windowMs) {
            budget.count = 0;
            budget.windowStart = now;
        }
        if (budget.count >= budget.maxPerWindow) {
            const wait = budget.windowMs - (now - budget.windowStart);
            await new Promise(r => setTimeout(r, Math.max(0, wait) + Math.random() * 500));
            budget.count = 0;
            budget.windowStart = Date.now();
        }
        budget.count++;
    }
};

function getCsrfToken() {
    if (harvesterCsrfToken) return harvesterCsrfToken;
    const m = document.cookie.match(/JSESSIONID="?ajax:([^";&]+)/);
    return m ? "ajax:" + m[1] : "";
}

// --- FIX 4: RATE LIMIT HANDLING ---
async function fetchOnePage(baseUrl, start, count) {
    try {
        const url = new URL(baseUrl.toString());
        url.searchParams.set("start", String(start));
        url.searchParams.set("count", String(count));
        const options = {
            credentials: "include",
            headers: {
                "accept": "application/vnd.linkedin.normalized+json+2.1",
                "x-restli-protocol-version": "2.0.0",
                "x-li-lang": "en_US",
                "csrf-token": getCsrfToken()
            }
        };
        let res = await fetch(url.toString(), options);
        if (res.status === 999 || res.status === 429) {
            console.warn("[Harvester] Rate limited — backing off 3s");
            await wait(3000);
            const retry = await fetch(url.toString(), options);
            if (!retry.ok) return null;
            return await retry.json();
        }
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

function tryStartReplayEngine(url, payload) {
    if (replayEngineStarted) return;
    const paging = payload?.paging || payload?.data?.paging;
    if (!paging?.total || !paging?.count) return;
    const total = parseInt(paging.total, 10);
    const count = parseInt(paging.count, 10) || 100;
    if (total <= count) return;
    replayEngineStarted = true;
    replayTotalPages = Math.ceil(total / count);
    scanStats.replayTotalPages = replayTotalPages;
    scanStats.replayPagesProcessed = 0;
    updatePhase("Fetching all " + total + " comments via replay…");
    const baseUrl = new URL(url, window.location.origin);
    replayCompletePromise = (async () => {
        for (let page = 1; page < replayTotalPages && isScanning; page += replayController.concurrency) {
            await requestBudget.consume("topLevel");
            const batch = [];
            for (let i = page; i < Math.min(page + replayController.concurrency, replayTotalPages); i++) {
                batch.push(fetchOnePage(baseUrl, i * count, count));
            }
            const results = await Promise.allSettled(batch);
            let anyRateLimit = false;
            for (let j = 0; j < results.length; j++) {
                const r = results[j];
                const pageIndex = page + j;
                if (r.status === "fulfilled" && r.value) {
                    const pageUrl = new URL(baseUrl.toString());
                    pageUrl.searchParams.set("start", String(pageIndex * count));
                    pageUrl.searchParams.set("count", String(count));
                    const bodyStr = JSON.stringify(r.value);
                    const len = bodyStr.length;
                    const sample = bodyStr.substring(0, 64) + (len > 128 ? bodyStr.substring(Math.floor(len / 2) - 32, Math.floor(len / 2) + 32) : "") + (len > 64 ? bodyStr.substring(len - 64) : "");
                    parseInterceptedPayload(r.value, pageUrl.toString(), sample);
                    scanStats.interceptedRequests++;
                    replayController.onSuccess();
                } else {
                    anyRateLimit = true;
                    scanStats.failedPages++;
                }
            }
            const pagesProcessed = Math.min(page + replayController.concurrency - 1, replayTotalPages);
            scanStats.replayPagesProcessed = pagesProcessed;
            scanStats.currentPhase = "Replaying page " + pagesProcessed + " of " + replayTotalPages;
            sendProgressThrottled();
            if (anyRateLimit) {
                const limitResult = replayController.onRateLimit();
                if (limitResult === "account_limited") {
                    updatePhase("LinkedIn is rate limiting your account. Please wait 15-30 minutes before scanning again.");
                    stopScan();
                    chrome.runtime.sendMessage({ action: "scanComplete", stats: scanStats, errorMessage: "rate_limited" }).catch(() => {});
                    return;
                }
                if (limitResult === "pause") {
                    updatePhase("Rate limited — pausing 10s...");
                    await wait(10000 + Math.random() * 2000);
                } else {
                    await wait(3000);
                }
            }
            if (page + replayController.concurrency < replayTotalPages) await wait(BATCH_DELAY_MS);
        }
    })();
}

function enqueueReplyReplay(url, payload) {
    let commentUrn;
    try {
        commentUrn = new URL(url, window.location.origin).searchParams.get("commentUrn");
    } catch (e) { return; }
    if (!commentUrn) return;
    if (replayedReplyUrns.has(commentUrn)) return;
    const paging = payload?.paging || payload?.data?.paging;
    if (!paging?.total || !paging?.count) return;
    const total = parseInt(paging.total, 10);
    const count = parseInt(paging.count, 10) || 25;
    if (total <= count) return;
    if (total < MIN_REPLY_REPLAY_THRESHOLD) return;
    replayedReplyUrns.add(commentUrn);
    replyReplayQueue.push({ url, paging, count, total });
    drainReplyQueue();
}

function drainReplyQueue() {
    while (replyReplayQueue.length > 0 && activeReplyReplays < MAX_CONCURRENT_REPLY_REPLAYS && isScanning) {
        const task = replyReplayQueue.shift();
        activeReplyReplays++;
        executeReplyReplay(task).finally(() => {
            activeReplyReplays--;
            drainReplyQueue();
        });
    }
}

async function executeReplyReplay(task) {
    const { url, paging, count, total } = task;
    const totalPages = Math.ceil(total / count);
    const baseUrl = new URL(url, window.location.origin);
    for (let page = 1; page < totalPages && isScanning; page += replayController.concurrency) {
        const batch = [];
        for (let i = page; i < Math.min(page + replayController.concurrency, totalPages); i++) {
            batch.push(fetchOnePage(baseUrl, i * count, count));
        }
        const results = await Promise.allSettled(batch);
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            const pageIndex = page + j;
            if (r.status === "fulfilled" && r.value) {
                const pageUrl = new URL(baseUrl.toString());
                pageUrl.searchParams.set("start", String(pageIndex * count));
                pageUrl.searchParams.set("count", String(count));
                parseInterceptedPayload(r.value, pageUrl.toString());
                scanStats.interceptedRequests++;
            }
        }
        if (page + replayController.concurrency < totalPages) await wait(BATCH_DELAY_MS);
    }
}

// --- DOM OBSERVER (MutationObserver) ---
function startDomObserver() {
    if (commentMutationObserver) return;
    const target = document.querySelector(".comments-comments-list") ||
        document.querySelector("[class*='comments-list']") ||
        document.body;
    commentMutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (
                    node.matches?.('[data-id^="urn:li:comment:"]') ||
                    node.querySelector?.('[data-id^="urn:li:comment:"]')
                ) {
                    domProgressCounter++;
                }
            }
        }
        clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = setTimeout(() => {
            lastDomChangeTimestamp = Date.now();
        }, 100);
    });
    commentMutationObserver.observe(target, { childList: true, subtree: true });
}

function stopDomObserver() {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = null;
    if (commentMutationObserver) {
        commentMutationObserver.disconnect();
        commentMutationObserver = null;
    }
}

// --- WAIT FOR PROGRESS ---
function waitForProgress(timeoutMs = 1500) {
    const startIntercepts = scanStats.interceptedRequests;
    const startDomCounter = domProgressCounter;
    let elapsed = 0;
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            elapsed += WAIT_FOR_PROGRESS_POLL_MS;
            const newIntercept = scanStats.interceptedRequests > startIntercepts;
            const newDomNode = domProgressCounter > startDomCounter;
            if (newIntercept || newDomNode || elapsed >= timeoutMs || !isScanning) {
                clearInterval(interval);
                resolve();
            }
        }, WAIT_FOR_PROGRESS_POLL_MS);
    });
}

function getAllUnclickedReplyButtons() {
    const buttons = findReplyButtons();
    return buttons.filter(b => !clickedReplyButtons.has(b));
}

const QUIET_WINDOW_CHECK_MS = 200;
function waitForQuietWindow() {
    let quietStart = null;
    return new Promise((resolve) => {
        const check = setInterval(() => {
            if (!isScanning) { clearInterval(check); resolve(); return; }
            const noLoadMoreButton = !findLoadMoreButton();
            const noVisibleReplyButtons = getAllUnclickedReplyButtons().length === 0;
            const noRecentIntercept = (Date.now() - lastInterceptTimestamp) > QUIET_WINDOW_MS;
            const noRecentDomChange = (Date.now() - lastDomChangeTimestamp) > QUIET_WINDOW_MS;
            const noActiveReplays = activeReplyReplays === 0 && replyReplayQueue.length === 0;
            const isQuiet = noLoadMoreButton && noVisibleReplyButtons && noRecentIntercept && noRecentDomChange && noActiveReplays;
            if (isQuiet) {
                if (!quietStart) quietStart = Date.now();
                if (Date.now() - quietStart >= QUIET_WINDOW_MS) {
                    clearInterval(check);
                    resolve();
                }
            } else {
                quietStart = null;
            }
        }, QUIET_WINDOW_CHECK_MS);
    });
}

// --- BUFFER POLLING (postMessage fallback) ---
function startBufferPolling() {
    if (bufferPollInterval) return;
    bufferPollInterval = setInterval(() => {
        try {
            if (!window.__harvesterBuffer || window.__harvesterBuffer.length === 0) return;
            const items = window.__harvesterBuffer.splice(0, window.__harvesterBuffer.length);
            for (const item of items) {
                if (isScanning && item.payload && item.url) parseInterceptedPayload(item.payload, item.url);
            }
        } catch (e) {}
    }, 100);
}

function stopBufferPolling() {
    if (bufferPollInterval) {
        clearInterval(bufferPollInterval);
        bufferPollInterval = null;
    }
}

// --- ENRICHMENT DURING SCAN (so live feed shows names, not "Unknown User") ---
const ENRICHMENT_SYNC_INTERVAL_MS = 1500;

function startEnrichmentSyncInterval() {
    if (enrichmentSyncIntervalId) return;
    enrichmentSyncIntervalId = setInterval(() => {
        if (!isScanning || emailMap.size === 0) return;
        enrichUnknownAuthorsFromDom();
        chrome.runtime.sendMessage({
            action: "syncResults",
            results: getValidResults()
        }).catch(() => {});
    }, ENRICHMENT_SYNC_INTERVAL_MS);
}

function clearEnrichmentSyncInterval() {
    if (enrichmentSyncIntervalId) {
        clearInterval(enrichmentSyncIntervalId);
        enrichmentSyncIntervalId = null;
    }
}

// --- ABSOLUTE TIMEOUT (extend on progress) ---
function scheduleAbsoluteTimeout() {
    if (absoluteTimeoutId) clearTimeout(absoluteTimeoutId);
    const remaining = Math.max(0, scanStartTimeForTimeout + absoluteDeadlineMs - Date.now());
    absoluteTimeoutId = setTimeout(() => {
        absoluteTimeoutId = null;
        if (!isScanning) return;
        // If we were extended, reschedule for remaining time instead of stopping
        const now = Date.now();
        if (now < scanStartTimeForTimeout + absoluteDeadlineMs) {
            scheduleAbsoluteTimeout();
            return;
        }
        console.warn("[Harvester] Absolute timeout reached — stopping scan");
        stopScan();
        const minutes = Math.round(absoluteDeadlineMs / 60000);
        updatePhase("Scan timed out after " + minutes + " minutes. Results so far have been saved.");
        chrome.runtime.sendMessage({ action: "scanComplete", stats: scanStats }).catch(() => {});
    }, remaining);
}

/** Call when email count or progress increases; extends deadline up to MAX_ABSOLUTE_SCAN_TIMEOUT_MS. */
function extendAbsoluteTimeoutIfProgress(currentTotal) {
    if (currentTotal <= lastExtendedCount) return;
    lastExtendedCount = currentTotal;
    absoluteDeadlineMs = Math.min(MAX_ABSOLUTE_SCAN_TIMEOUT_MS, absoluteDeadlineMs + EXTEND_ON_PROGRESS_MS);
    scheduleAbsoluteTimeout();
}

// --- DELTA SYNC ---
function sendProgressThrottled(force) {
    const now = Date.now();
    if (!force && now - lastProgressSent < PROGRESS_THROTTLE_MS) return;
    lastProgressSent = now;
    const validRecords = getValidResults();
    const newRecords = validRecords.slice(lastSyncedCount);
    lastSyncedCount = validRecords.length;
    extendAbsoluteTimeoutIfProgress(validRecords.length);
    chrome.runtime.sendMessage({
        action: "progressUpdate",
        stats: { ...scanStats },
        newRecords,
        totalCount: validRecords.length
    }).catch(() => {});
}

// --- Module 3: Smart Button Clicker (The Trigger) ---

function detectPostState() {
    if (document.querySelector("[class*='comments-disabled'], [data-test-id*='comments-disabled']")) {
        return { state: "disabled", message: "Comments are disabled on this post." };
    }
    const commentSection = document.querySelector(".comments-comments-list, [class*='comments-list']");
    if (!commentSection) {
        return { state: "not_found", message: "Comments section not found. Scroll to comments and try again." };
    }
    if (document.querySelector("#session_key, [data-test-id='sign-in-form']")) {
        return { state: "logged_out", message: "Please log in to LinkedIn first." };
    }
    return { state: "ok" };
}

async function verifySortOrder() {
    await wait(500);
    const btn = document.querySelector("button.comments-sort-order-toggle__dropdown, button[class*='comments-sort-order-toggle']");
    const text = (btn && btn.textContent) || "";
    const verified = /most recent/i.test(text) || /reciente|récent|neueste|nieuwste|recente/i.test(text);
    if (!verified) {
        console.warn("[Harvester] Sort switch unverified");
        updatePhase("Warning: sort may be limited to ~600 comments");
    }
    return verified;
}

/**
 * Switch LinkedIn comment sort from "Most Relevant" to "Most Recent" (locale-safe: try first option).
 */
async function switchToMostRecentComments() {
    updatePhase("Switching to Most Recent...");
    sendProgressThrottled();

    try {
        const toggleContainer = document.querySelector("div[class*='comments-sort-order-toggle']");
        const sortToggle = document.querySelector("button.comments-sort-order-toggle__dropdown") ||
            (toggleContainer && toggleContainer.querySelector("button"));

        if (!sortToggle || !isVisible(sortToggle)) return;

        const buttonText = (sortToggle.textContent || "").trim().toLowerCase();
        if (/most\s+recent|reciente|récent|neueste|nieuwste|recente/.test(buttonText)) return;

        sortToggle.scrollIntoView({ behavior: "auto", block: "center" });
        await wait(150);
        sortToggle.click();
        await wait(800);

        const options = document.querySelectorAll("[class*='sort-order-toggle__content'] [role='option'], [class*='sort-order-toggle__content'] li, [class*='sort-order-toggle__content'] button");
        if (options.length === 0) {
            const openPanel = document.querySelector(".artdeco-dropdown_content--is-open");
            const searchRoot = openPanel || document.body;
            const candidates = searchRoot.querySelectorAll("button, a, [role='button'], [role='option'], li, div");
            let targetOption = null;
            for (const opt of candidates) {
                if (sortToggle.contains(opt)) continue;
                const t = (opt.textContent || "").trim().toLowerCase();
                if (/recent|reciente|récent|neueste|nieuwste|recente/.test(t) && !/relevant|relevante/.test(t)) {
                    targetOption = opt;
                    break;
                }
            }
            if (targetOption) {
                targetOption.click();
            }
        } else {
            let targetOption = null;
            for (const opt of options) {
                const t = (opt.textContent || "").trim().toLowerCase();
                if (/recent|reciente|récent|neueste|nieuwste|recente/.test(t)) {
                    targetOption = opt;
                    break;
                }
            }
            (targetOption || options[0]).click();
        }
        await wait(2000);
        const firstComment = document.querySelector("[data-id^='urn:li:comment:'], .comments-comment-item, [class*='comments-comment-item']");
        if (firstComment) {
            firstComment.scrollIntoView({ behavior: "auto", block: "start" });
            await wait(200);
        }
    } catch (e) {
        console.warn("[Harvester] Sort switch error (continuing):", e);
    }
}

async function clickSeeMoreButtons() {
    const selectors = [
        '[class*="inline-show-more-text"] button',
        'button[class*="see-more"]',
        'span[class*="see-more"]'
    ];
    const buttons = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);

    for (const btn of buttons) {
        if (!isScanning) break;
        try {
            btn.click();
            await wait(CONFIG.SEE_MORE_WAIT_MS);
        } catch (e) { }
    }
}

async function scrollCommentsAreaDown() {
    const list = document.querySelector(".comments-comments-list, [class*='comments-list']");
    if (list) {
        list.scrollTop = list.scrollHeight;
        await wait(350);
    }
    const container = document.querySelector(".social-details-social-activity, [class*='comments']");
    if (container) {
        container.scrollIntoView({ behavior: "auto", block: "end" });
        await wait(250);
    }
}

/** Aggressive scroll so "Load more comments" appears (LinkedIn often shows it only when bottom is in view). */
async function scrollCommentsAndPageToBottom() {
    const list = document.querySelector(".comments-comments-list, [class*='comments-list']");
    if (list) {
        for (let i = 0; i < 3; i++) {
            list.scrollTop = list.scrollHeight;
            await wait(200);
        }
    }
    const container = document.querySelector(".social-details-social-activity, [class*='comments']");
    if (container) {
        container.scrollIntoView({ behavior: "auto", block: "end" });
        await wait(300);
    }
    window.scrollBy(0, 400);
    await wait(200);
}

/** @returns {{ loadClicks: number, exitedBecauseNoButton: boolean }} */
async function loadMoreCommentsLoop() {
    let clicks = 0;
    let noButtonCount = 0;
    let exitedBecauseNoButton = false;

    while (isScanning && clicks < CONFIG.MAX_LOAD_MORE_CLICKS) {
        let btn = findLoadMoreButton();
        if (!btn) {
            noButtonCount++;
            if (noButtonCount >= NO_BUTTON_ROUNDS_BEFORE_GIVE_UP) {
                exitedBecauseNoButton = true;
                break;
            }
            await scrollCommentsAndPageToBottom();
            await wait(200);
            btn = findLoadMoreButton();
            if (!btn) {
                await wait(100);
                btn = findLoadMoreButton();
            }
            if (!btn) continue;
        } else {
            noButtonCount = 0;
        }

        try {
            btn.scrollIntoView({ behavior: "auto", block: "center" });
            await wait(80);
            btn.click();
            clicks++;
            if (clicks % SCROLL_COMMENTS_EVERY_N_CLICKS === 0) await scrollCommentsAreaDown();
            await waitForProgress(CONFIG.LOAD_MORE_WAIT_MS);
        } catch (e) {
            console.warn("Load more click failed", e);
            break;
        }
    }
    return { loadClicks: clicks, exitedBecauseNoButton };
}

/** @returns {{ replyClicks: number }} */
async function expandRepliesLoop() {
    let totalClicks = 0;
    let batchesWithNoNew = 0;

    while (isScanning && totalClicks < CONFIG.MAX_REPLY_CLICKS && batchesWithNoNew < 5) {
        const buttons = findReplyButtons();
        const unclicked = buttons.filter(b => !clickedReplyButtons.has(b));

        if (unclicked.length === 0) {
            batchesWithNoNew++;
            await wait(200);
            continue;
        }
        batchesWithNoNew = 0;
        const batch = unclicked.slice(0, REPLY_CLICK_BATCH_SIZE);

        for (const btn of batch) {
            clickedReplyButtons.add(btn);
            btn.scrollIntoView({ behavior: "auto", block: "nearest" });
            btn.click();
            totalClicks++;
            scanStats.repliesExpanded++;
            await wait(20);
        }
        await waitForProgress(1000);
        sendProgressThrottled();
    }
    return { replyClicks: totalClicks };
}


function countCommentElements() {
    const sel = '[data-id^="urn:li:comment:"]';
    const byDataId = document.querySelectorAll(sel).length;
    if (byDataId > 0) return byDataId;
    const byClass = document.querySelectorAll('.comments-comment-item, [class*="comments-comment-item"]').length;
    return byClass > 0 ? byClass : document.querySelectorAll(sel).length;
}

function findLoadMoreButton() {
    const selectors = [
        'button[aria-label*="Load more comments"]',
        'button[aria-label*="Load more"]',
        'button[class*="load-more"]',
        'button[class*="load-more-comments"]',
        '.comments-comments-list__load-more-comments-button',
        '[class*="load-more-comments"]'
    ];
    for (const s of selectors) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
            if (isVisible(el) && /load\s*more\s*(comments)?/i.test(el.innerText || el.getAttribute("aria-label") || "")) return el;
        }
    }
    const allButtons = Array.from(document.querySelectorAll('button'));
    return allButtons.find(b => isVisible(b) && /load\s*more\s*(comments)?/i.test(b.innerText || ""));
}

/**
 * Only "View X replies" / "See previous replies" (expand thread). NEVER the "Reply" button (write action).
 */
function findReplyButtons() {
    const allButtons = Array.from(document.querySelectorAll('button'));
    return allButtons.filter(b => {
        if (!isVisible(b)) return false;
        const text = (b.textContent || b.getAttribute("aria-label") || "").trim();
        // Must look like "View 3 replies" or "See previous replies" — not just "Reply"
        if (/^\s*reply\s*$/i.test(text)) return false; // exact "Reply" = write action, skip
        if (/view\s+\d+\s+repl/i.test(text)) return true;  // "View 5 replies"
        if (/see\s+(previous|more)\s+repl/i.test(text)) return true; // "See previous replies"
        if (/\d+\s+repl/i.test(text)) return true;        // "5 replies" (expand)
        return false;
    });
}


// --- Module 4: JSON Parser (The Harvester) ---

// --- PAYLOAD DEDUPER (LRU) ---
let seenPayloadKeys = new LRUCache(5000);
function isPayloadAlreadySeen(url, payload, bodyStr) {
    const key = getPayloadKey(url, payload, bodyStr || "");
    if (seenPayloadKeys.has(key)) return true;
    seenPayloadKeys.add(key);
    return false;
}

function parseInterceptedPayload(payload, url, bodySample) {
    if (!payload || typeof payload !== "object") return;
    if (isPayloadAlreadySeen(url, payload, bodySample || "")) return;

    scanStats.interceptedRequests++;
    lastInterceptTimestamp = Date.now();
    updatePhase("Parsing responses");

    let isReplySource = false;
    try {
        isReplySource = new URL(url, window.location.origin).searchParams.has("commentUrn");
    } catch (e) {}

    tryStartReplayEngine(url, payload);
    enqueueReplyReplay(url, payload);
    if (firstInterceptResolve) {
        const resolve = firstInterceptResolve;
        firstInterceptResolve = null;
        resolve();
    }

    let commentCandidates = [];

    if (payload.elements && Array.isArray(payload.elements)) {
        commentCandidates.push(...payload.elements);
    }
    if (payload.data?.elements && Array.isArray(payload.data.elements)) {
        commentCandidates.push(...payload.data.elements);
    }
    if (payload.included && Array.isArray(payload.included)) {
        commentCandidates.push(...payload.included);
    }

    // Nested replies: element.comments?.elements[], element.socialDetail?.comments?.elements[]
    const nested = [];
    for (const item of commentCandidates) {
        if (!item) continue;
        if (item.comments?.elements && Array.isArray(item.comments.elements)) {
            nested.push(...item.comments.elements);
        }
        if (item.socialDetail?.comments?.elements && Array.isArray(item.socialDetail.comments.elements)) {
            nested.push(...item.socialDetail.comments.elements);
        }
    }
    commentCandidates = commentCandidates.concat(nested);

    const includedCtx = payload.included || [];
    for (const item of commentCandidates) {
        if (!item) continue;

        const urn = item.entityUrn || item.urn || "";
        const type = item.$type || "";

        const isComment = urn.includes("urn:li:comment") ||
            urn.includes("urn:li:fsd_comment") ||
            type.includes("Comment");

        if (isComment) {
            const records = parseCommentJson(item, includedCtx, isReplySource);
            if (records && records.length > 0) {
                scanStats.commentsScanned++;
                for (const record of records) {
                    mergeIntoEmailMap(record, { isReplySource });
                }
            }
        }
    }

    sendProgressThrottled();
}

/** Gate deep email extraction: only extract when text contains @ or mailto (avoids silent drop of paging/URN payloads). */
function shouldExtractEmails(text) {
    return text && (String(text).includes("@") || String(text).includes("mailto:"));
}

// FIXED: multiple emails per comment now create separate EmailRecord entries
/**
 * Returns an array of email records for this comment (one per email in the comment text).
 * Comments with multiple emails (e.g. "a@x.com b@y.com") produce multiple records with the same author/snippet.
 */
function parseCommentJson(item, includedCtx, isReplySource) {
    if (!item || typeof item !== "object") return [];
    const text = resolveField(item,
        "commentV2.text",
        "commentary.text",
        "message.text",
        "text.text",
        "comment.values.0.value"
    );
    if (!text) return [];
    if (!shouldExtractEmails(text)) return [];

    // FIX BUG 2: cap emails per comment to limit false positives
    const MAX_EMAILS_PER_COMMENT = 5;
    const rawEmails = extractAllEmailsFromText(text);
    if (rawEmails.length === 0) return [];
    const emails = rawEmails.slice(0, MAX_EMAILS_PER_COMMENT);
    if (rawEmails.length > MAX_EMAILS_PER_COMMENT) {
        console.warn("[Harvester] Capped comment from " + rawEmails.length + " to " + MAX_EMAILS_PER_COMMENT + " emails");
    }

    // Author: try multiple API paths (top-level and reply shapes); then resolve from included by actor/commenter URN
    let authorName = resolveField(item,
        "commenter.com.linkedin.voyager.feed.MemberActor.name.text",
        "commenter.actor.name.text",
        "actor.name.text",
        "author.name.text",
        "commenter.name.text",
        "creator.name.text",
        "creator.firstName",
        "commenter.firstName",
        "from.com.linkedin.voyager.messaging.MessagingMember.miniProfile.firstName",
        "value.author.name",
        "value.creator.name"
    );
    if (!authorName) {
        const first = resolveField(item,
            "commenter.com.linkedin.voyager.feed.MemberActor.miniProfile.firstName",
            "commenter.actor.miniProfile.firstName",
            "actor.miniProfile.firstName",
            "commenter.miniProfile.firstName",
            "commenter.firstName",
            "creator.miniProfile.firstName",
            "creator.firstName"
        );
        const last = resolveField(item,
            "commenter.com.linkedin.voyager.feed.MemberActor.miniProfile.lastName",
            "commenter.actor.miniProfile.lastName",
            "actor.miniProfile.lastName",
            "commenter.miniProfile.lastName",
            "commenter.lastName",
            "creator.miniProfile.lastName",
            "creator.lastName"
        );
        if (first || last) authorName = [first, last].filter(Boolean).join(" ").trim();
    }
    let authorTitle = resolveField(item,
        "commenter.com.linkedin.voyager.feed.MemberActor.description.text",
        "commenter.actor.headline",
        "actor.headline",
        "commenter.miniProfile.occupation",
        "actor.occupation",
        "commenter.headline"
    ) || "";

    let profileUrl = resolveField(item,
        "commenter.com.linkedin.voyager.feed.MemberActor.navigationUrl",
        "commenter.com.linkedin.voyager.feed.MemberActor.miniProfile.publicIdentifier",
        "commenter.actor.navigationUrl",
        "commenter.actor.miniProfile.publicIdentifier",
        "actor.miniProfile.publicIdentifier",
        "actor.navigationUrl",
        "commenter.publicIdentifier"
    );
    if (profileUrl && !profileUrl.startsWith("http")) profileUrl = `https://www.linkedin.com/in/${String(profileUrl).replace(/^\//, "")}`;
    if (!profileUrl) profileUrl = "";

    if (Array.isArray(includedCtx)) {
        const commenterRef = resolveField(item, "commenter", "creator", "actor", "from");
        let urn = "";
        if (typeof commenterRef === "string" && /^urn:li:/.test(commenterRef)) {
            urn = commenterRef;
        } else if (commenterRef && typeof commenterRef === "object") {
            urn = commenterRef.entityUrn || commenterRef.urn || "";
        }
        if (!urn) {
            urn = resolveField(item, "commenter.actor", "commenter.entityUrn", "actor.entityUrn", "actor", "from.entityUrn", "from");
            if (urn && typeof urn === "object") urn = urn.entityUrn || urn.urn || "";
            if (typeof urn !== "string") urn = "";
        }
        const resolved = includedCtx.find((e) => {
            const eUrn = (e && (e.entityUrn || e.urn || e.id || (e.miniProfile && (e.miniProfile.entityUrn || e.miniProfile.urn)))) || "";
            if (!urn || !eUrn) return false;
            if (eUrn === urn || urn === eUrn) return true;
            if (String(urn).includes(eUrn) || String(eUrn).includes(urn)) return true;
            return false;
        });
        if (resolved) {
            if (!authorName || authorName === "Unknown User") {
                authorName = resolveField(resolved, "name.text", "firstName", "miniProfile.firstName", "com.linkedin.voyager.identity.shared.MiniProfile.firstName", "name") || "";
                if (!authorName) {
                    const f = resolveField(resolved, "miniProfile.firstName", "firstName", "com.linkedin.voyager.identity.shared.MiniProfile.firstName");
                    const l = resolveField(resolved, "miniProfile.lastName", "lastName", "com.linkedin.voyager.identity.shared.MiniProfile.lastName");
                    if (f || l) authorName = [f, l].filter(Boolean).join(" ").trim();
                }
            }
            if (!authorTitle) authorTitle = resolveField(resolved, "headline", "occupation", "miniProfile.occupation", "description.text", "miniProfile.headline") || "";
            if (!profileUrl) {
                const p = resolveField(resolved, "navigationUrl", "miniProfile.publicIdentifier", "publicIdentifier", "miniProfile.navigationUrl");
                profileUrl = (p && !p.startsWith("http") ? `https://www.linkedin.com/in/${String(p).replace(/^\//, "")}` : (p || "")) || "";
            }
        }
    }

    // Fallback: scan all included for any MiniProfile/Member with name (item may reference by different key)
    if ((!authorName || authorName === "Unknown User") && Array.isArray(includedCtx)) {
        for (const e of includedCtx) {
            if (!e || typeof e !== "object") continue;
            const ref = item.commenter || item.creator || item.actor || item.from;
            const refUrn = typeof ref === "string" ? ref : (ref && (ref.entityUrn || ref.urn));
            const eUrn = e.entityUrn || e.urn || e.id;
            if (!refUrn || !eUrn) continue;
            if (refUrn !== eUrn && !String(refUrn).includes(eUrn) && !String(eUrn).includes(refUrn)) continue;
            const f = resolveField(e, "miniProfile.firstName", "firstName", "name.text");
            const l = resolveField(e, "miniProfile.lastName", "lastName");
            if (typeof f === "string" || typeof l === "string") {
                authorName = [f, l].filter(function (x) { return typeof x === "string" && x.trim(); }).join(" ").trim();
                if (authorName) break;
            }
        }
    }

    authorName = sanitizeText((authorName && String(authorName).trim()) || "Unknown User");
    if (/^[a-zA-Z0-9._-]{2,}$/.test(authorName) && authorName.length > 20 && !/\s/.test(authorName)) authorName = "Unknown User";
    authorTitle = sanitizeText((authorTitle && String(authorTitle).trim()) || "");

    const snippet = text.substring(0, 100);
    const base = {
        authorName,
        authorTitle,
        linkedinProfileUrl: profileUrl,
        postUrl: window.location.href,
        extractedAtISO: scanStartTimestamp || new Date().toISOString(),
        commentSnippet: snippet,
        sourceType: isReplySource ? "reply" : "comment",
        seenCount: 1
    };
    return emails.map((email) => ({ ...base, email }));
}

function resolveField(obj, ...paths) {
    for (const path of paths) {
        const keys = path.split(".");
        let val = obj;
        for (const key of keys) {
            val = val?.[key];
            if (val === undefined || val === null) break;
        }
        if (val !== undefined && val !== null && val !== "") return val;
    }
    return null;
}

/** BUG 1: Normalize comment text so emails are not concatenated (e.g. domain.comNextEmail -> domain.com NextEmail). */
function normalizeCommentText(text) {
    if (!text) return "";
    return text
        // Normalize all whitespace to single spaces
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        // Insert space at TLD boundary ONLY when immediately followed
        // by a letter (concatenation case like "gmail.comNextPerson")
        // Rules:
        //   1. Longest TLDs first to prevent partial matches
        //   2. .co intentionally excluded — it is a real valid TLD
        //      and including it would split ".com" as ".co" + "m"
        //   3. Lookahead (?=[a-zA-Z]) does not consume the next letter
        .replace(/\.(com|org|net|edu|gov|info|io|ai|in)(?=[a-zA-Z])/g, ".$1 ")
        // Handle @ concatenation: insert space before @ when
        // preceded by non-space (e.g. "domain.comuser@next.com")
        .replace(/([^\s])@/g, "$1 @")
        // Remove any spaces that crept inside an email address
        // around the @ symbol
        .replace(/\s*@\s*/g, "@")
        .trim();
}

/** Single source for regex-based email extraction; uses normalized text, filters bad TLD and phone-like local parts. */
function extractEmailsFromText(rawText) {
    const text = normalizeCommentText(rawText).replace(/\s*@\s*/g, "@");
    const regex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(regex) || [];
    return matches
        .map((e) => e.toLowerCase().trim())
        .filter((e) => {
            const local = e.split("@")[0];
            if (/^\d{8,}$/.test(local)) return false;
            return true;
        })
        .filter((e) => {
            const tld = e.split(".").pop();
            const badExtensions = [
                "png", "jpg", "gif", "svg", "mp4",
                "pdf", "zip", "js", "css"
            ];
            // .co removed — real country-code TLD
            return !badExtensions.includes(tld);
        })
        .filter((e) => e.length <= 254 && e.length >= 6);
}

/** Returns the first normalized email in text (for backward compatibility). */
function extractEmailFromText(text) {
    const all = extractAllEmailsFromText(text);
    return all.length > 0 ? all[0] : null;
}

/**
 * Returns all unique normalized emails in text. Uses normalizeCommentText + extractEmailsFromText,
 * then filters concatenated/malformed and fragment duplicates.
 */
function extractAllEmailsFromText(text) {
    if (!text || typeof text !== "string") return [];
    const normalized = normalizeCommentText(text).replace(/\s*@\s*/g, "@");
    const seen = new Set();
    const out = [];
    if (normalized.includes("mailto:")) {
        const parts = normalized.split(/mailto:/gi);
        for (let i = 1; i < parts.length; i++) {
            const potential = parts[i].split(/[\s?"]/)[0];
            if (potential && potential.includes("@")) {
                const e = normalizeEmail(potential);
                if (e && !seen.has(e) && !isEmailLikelyInvalid(e)) { seen.add(e); out.push(e); }
            }
        }
    }
    for (const e of extractEmailsFromText(normalized)) {
        const norm = normalizeEmail(e);
        if (norm && !seen.has(norm) && !isEmailLikelyInvalid(norm)) { seen.add(norm); out.push(norm); }
    }
    return out;
}

function normalizeEmail(email) {
    if (!email || typeof email !== "string") return null;
    let clean = email.toLowerCase().replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, "").trim();
    if (!clean.includes("@") || clean.length > 254) return null;
    const badTLDs = ["png", "jpg", "gif", "svg", "mp4", "pdf", "zip"];
    // .co removed — it is a real country-code TLD (Colombia, startups)
    const tld = clean.split('.').pop();
    if (badTLDs.includes(tld)) return null;
    return clean;
}

/**
 * Rejects emails that are clearly concatenated or malformed (e.g. domain.com + name
 * producing "domain.comname", or fragment like "971@gmail.com" when full is "kuppalamadhu.971@gmail.com").
 */
function isEmailLikelyInvalid(email) {
    if (!email || typeof email !== "string") return true;
    const e = email.toLowerCase().trim();
    const at = e.indexOf("@");
    if (at <= 0 || at >= e.length - 4) return true;
    const domain = e.slice(at + 1);
    if (!domain || !domain.includes(".")) return true;
    // Reject if domain contains a known TLD immediately followed by more alphanumeric (no dot): e.g. visionsquareit.comyppalomadhup or aplombtek.comteja83551234
    if (/\.(com|org|net|in|co|io|ai|edu)([a-zA-Z0-9]{2,})/.test(domain)) return true;
    // Reject local part that is only digits or too short (common fragment from split "name.971" + "971@gmail.com")
    const local = e.slice(0, at);
    if (/^\d+$/.test(local)) return true;
    if (local.length < 2) return true;
    // FIX BUG 2: tighten validation
    if (!local || !domain) return true;
    if (local.includes("..")) return true;
    const tld = domain.split(".").pop();
    if (!tld || tld.length > 6) return true;
    if (/\s/.test(e)) return true;
    const obviousFakes = ["test@test.com", "example@example.com", "email@email.com", "user@user.com"];
    if (obviousFakes.includes(e)) return true;
    return false;
}

/** Returns only records with valid email (no fragments). Used for getResults and progress so counts match. */
function getValidResults() {
    const all = Array.from(emailMap.values());
    const valid = all.filter((r) => r.email && !isEmailLikelyInvalid(r.email));
    if (valid.length > 0) return valid;
    if (all.length > 0) return all;
    return [];
}

/** Remove only obvious fragments: drop A if A is substring of B and A does not look like a full email (no @). Preserves jane@company.co vs jane@company.com. */
function dropSubstringEmails(list) {
    if (!Array.isArray(list) || list.length <= 1) return list;
    const out = [];
    for (const e of list) {
        const looksLikeFullEmail = e && String(e).includes("@");
        const isFragmentSubstring = list.some((other) => other !== e && other.length > e.length && other.includes(e) && !looksLikeFullEmail);
        if (!isFragmentSubstring) out.push(e);
    }
    return out;
}

/** BUG 3: Sanitize author name/title (remove emoji and control chars). Never apply to email. */
function sanitizeText(text) {
    if (!text) return "";
    return String(text)
        .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, "")
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
        .replace(/\s*\|\s*/g, " | ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** BUG 2: Merge new record into emailMap; never overwrite good API data with DOM fallback. */
function mergeIntoEmailMap(newRecord, opts) {
    const key = (newRecord.email || "").toLowerCase().trim();
    if (!key) return;
    // Reject fragments and invalid emails at the gate (e.g. "prem", "user@", "user@gma")
    if (!key.includes("@") || isEmailLikelyInvalid(key)) return;
    const isReplySource = opts && opts.isReplySource;

    if (emailMap.has(key)) {
        scanStats.duplicatesRemoved++;
        const existing = emailMap.get(key);
        existing.seenCount = (existing.seenCount || 1) + 1;
        if (!existing.authorName || existing.authorName === "Unknown" || existing.authorName === "Unknown User") {
            existing.authorName = newRecord.authorName || existing.authorName;
        }
        if (!existing.authorTitle) {
            existing.authorTitle = newRecord.authorTitle || existing.authorTitle;
        }
        if (!existing.linkedinProfileUrl) {
            existing.linkedinProfileUrl = newRecord.linkedinProfileUrl || existing.linkedinProfileUrl;
        }
        if (!existing.commentSnippet) {
            existing.commentSnippet = newRecord.commentSnippet || existing.commentSnippet;
        }
        if (existing.sourceType === "fallback" && (newRecord.sourceType === "comment" || newRecord.sourceType === "reply")) {
            existing.sourceType = newRecord.sourceType;
        }
        emailMap.set(key, existing);
    } else {
        emailMap.set(key, { ...newRecord, email: key, seenCount: 1 });
        scanStats.emailsFound++;
        if (newRecord.sourceType !== "fallback") {
            if (isReplySource) scanStats.replyEmailsCount++;
            else scanStats.apiEmailsCount++;
        }
    }
}

// --- Module 5: Fallback & Utilities ---

/** Get display name from a comment container; prefer profile link text. */
function getAuthorNameFromContainer(container) {
    const profileLinks = container.querySelectorAll("a[href*='/in/']");
    for (const a of profileLinks) {
        const t = (a.textContent || "").trim();
        if (!t || t.length > 80) continue;
        if (/\s/.test(t) || t.length < 40) return t;
        if (/^[A-Za-z][a-z]*\s+[A-Za-z.]+\s*$/.test(t)) return t;
    }
    const titleEl = container.querySelector("span.comments-comment-meta__description-title");
    if (titleEl) {
        const t = (titleEl.textContent || "").trim();
        if (t && t.length < 80 && !/^[a-zA-Z0-9._-]{25,}$/.test(t)) return t;
    }
    for (const sel of ["[class*='comment-meta']", "[class*='commenter']", "[class*='actor-name']", "[class*='description-title']"]) {
        const el = container.querySelector(sel);
        if (el) {
            const t = (el.textContent || "").trim();
            if (t && t.length >= 2 && t.length <= 80 && !/^[\d@.]+$/.test(t) && !t.includes("@")) return t;
        }
    }
    const aria = container.querySelector("[aria-label]");
    if (aria) {
        const t = (aria.getAttribute("aria-label") || "").trim();
        if (t && t.length < 80) return t;
    }
    const strongOrB = container.querySelector("strong, b");
    if (strongOrB) {
        const t = (strongOrB.textContent || "").trim();
        if (t && t.length >= 2 && t.length <= 80 && !t.includes("@")) return t;
    }
    return "";
}

/** Get headline/title from a comment container (e.g. "Systems Engineer @ TCS" or "Computer Science Master's Student |..."). */
function getAuthorTitleFromContainer(container) {
    const selectors = [
        "span.comments-comment-meta__description-subtitle",
        "div.comments-comment-meta__description-subtitle",
        "[class*='comments-comment-meta'][class*='description-subtitle']",
        "[class*='description-subtitle']"
    ];
    for (const sel of selectors) {
        const sub = container.querySelector(sel);
        if (sub) {
            const t = (sub.textContent || "").trim().substring(0, 200);
            if (t) return t;
        }
    }
    const profileLink = container.querySelector("a[href*='/in/']");
    if (profileLink) {
        const aria = (profileLink.getAttribute("aria-label") || "").trim();
        if (aria) {
            const m = aria.match(/View:\s*(?:\S+\s+)+?(?:\d+(?:st|nd|rd|th)\s+)?(.+)/i);
            if (m && m[1]) {
                const raw = m[1].trim();
                const title = (raw.split("|")[0] || raw).trim().substring(0, 200);
                if (title.length > 2) return title;
            }
        }
    }
    return "";
}

function getCommentContainers() {
    const byDataId = document.querySelectorAll('[data-id^="urn:li:comment:"]');
    if (byDataId.length > 0) return Array.from(byDataId);
    const byClass = document.querySelectorAll('.comments-comment-item, [class*="comments-comment-item"], [class*="comment-item"]');
    if (byClass.length > 0) return Array.from(byClass);
    return Array.from(document.querySelectorAll('[data-id^="urn:li:comment:"]'));
}

/** Fill in Unknown User / missing profile / missing title from visible DOM by matching email. */
function enrichUnknownAuthorsFromDom() {
    const containers = getCommentContainers();
    const emailLower = (s) => (s || "").toLowerCase();
    for (const record of emailMap.values()) {
        const needsName = record.authorName === "Unknown User" || record.authorName === "Unknown";
        const needsProfile = !record.linkedinProfileUrl;
        const needsTitle = !record.authorTitle || (record.authorTitle || "").trim() === "";
        if (!needsName && !needsProfile && !needsTitle) continue;
        const recordEmailLower = emailLower(record.email);
        for (const container of containers) {
            const text = normalizeCommentText(container.textContent || "");
            if (!recordEmailLower || !emailLower(text).includes(recordEmailLower)) continue;
            const name = getAuthorNameFromContainer(container);
            if (name && name.trim() && name !== "Unknown User" && name !== "Unknown") record.authorName = sanitizeText(name.trim());
            const title = getAuthorTitleFromContainer(container);
            if (title) record.authorTitle = sanitizeText(title);
            if (!record.linkedinProfileUrl) {
                const a = container.querySelector("a[href*='/in/']");
                if (a) {
                    let href = (a.getAttribute("href") || "").split("?")[0];
                    if (href && !href.startsWith("http")) href = "https://www.linkedin.com" + (href.startsWith("/") ? href : "/" + href);
                    record.linkedinProfileUrl = href || "";
                }
            }
            break;
        }
    }
}

/** Every N comment containers we send a progress update so the panel shows live email/comment counts during DOM fallback. */
const DOM_PROGRESS_UPDATE_EVERY_N_CONTAINERS = 25;

/** BUG 4: Only extract from inside comment containers — never document-level mailto/text. */
function fallbackDomScan() {
    const commentContainers = getCommentContainers();
    const newRecords = [];
    let containersProcessed = 0;

    for (const root of commentContainers) {
        if (!isScanning) break;
        const authorName = sanitizeText(getAuthorNameFromContainer(root) || "Unknown");
        const authorTitle = sanitizeText(getAuthorTitleFromContainer(root) || "");
        const profileLink = root.querySelector("a[href*='/in/']");
        const linkedinProfileUrl = profileLink ? (profileLink.getAttribute("href") || "").split("?")[0] : "";

        const candidates = new Set();
        const mailtoLinks = root.querySelectorAll('a[href^="mailto:"]');
        for (const a of mailtoLinks) {
            const href = (a.getAttribute("href") || "").replace(/^mailto:/i, "").trim();
            const potential = href.split(/[\s?"]/)[0];
            if (potential && potential.includes("@")) {
                const email = normalizeEmail(potential);
                if (email && !isEmailLikelyInvalid(email)) candidates.add(email);
            }
        }
        const text = normalizeCommentText(root.textContent || "");
        for (const email of extractEmailsFromText(text)) {
            const norm = normalizeEmail(email);
            if (norm && !isEmailLikelyInvalid(norm)) candidates.add(norm);
        }
        const validList = Array.from(candidates);

        // FIX BUG 2: only count container once if it contributed new emails (prevent double-count when API + DOM both run)
        let newEmailsFromThisContainer = 0;
        for (const email of validList) {
            const wasNew = !emailMap.has(email);
            const record = {
                email,
                authorName,
                authorTitle,
                linkedinProfileUrl: linkedinProfileUrl || "",
                postUrl: window.location.href,
                extractedAtISO: scanStartTimestamp || new Date().toISOString(),
                commentSnippet: (text.substring(0, 100) || "Extracted via DOM fallback").replace(/\s+/g, " "),
                sourceType: "fallback",
                seenCount: 1
            };
            mergeIntoEmailMap(record);
            if (wasNew) {
                newEmailsFromThisContainer++;
                newRecords.push(record);
            }
        }
        if (newEmailsFromThisContainer > 0) {
            scanStats.commentsScanned++;
        }
        containersProcessed++;
        // Real-time UI: send progress every N containers so COMMENTS and EMAILS counts update during DOM scan
        if (containersProcessed % DOM_PROGRESS_UPDATE_EVERY_N_CONTAINERS === 0) {
            sendProgressThrottled(true);
        }
    }

    if (newRecords.length > 0) {
        scanStats.domEmailsCount = (scanStats.domEmailsCount || 0) + newRecords.length;
    }
    sendProgressThrottled(true);
}

// Stats & UI Helpers
function extractTotalCommentCount() {
    // Try reliable selector
    const el = document.querySelector('.social-details-social-counts__comments');
    if (el) {
        const match = el.textContent.match(/([0-9,.]+)\s+comments?/i);
        if (match) return parseInt(match[1].replace(/[,.]/g, ''), 10);
    }
    return 0;
}

function updatePhase(phaseName) {
    scanStats.currentPhase = phaseName;
    sendProgressThrottled();
}

/** At scan end only: remove true fragments (no @) from emailMap. Never drop valid emails. */
function removeFragmentEmailsFromMap() {
    const allEmails = [...emailMap.keys()];
    for (const email of allEmails) {
        if (!email.includes("@")) emailMap.delete(email);
    }
}

function sendScanComplete() {
    chrome.runtime.sendMessage({
        action: "scanComplete",
        stats: scanStats
    }).catch(() => { });
}

function showToast(msg) {
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText = "position:fixed; top:10px; right:10px; z-index:9999; background:#0a66c2; color:white; padding:10px; border-radius:4px; font-weight:bold; box-shadow:0 2px 5px rgba(0,0,0,0.2); font-family:sans-serif; font-size:14px;";
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}

function isVisible(elem) {
    return !!(elem.offsetWidth || elem.offsetHeight || elem.getClientRects().length);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
