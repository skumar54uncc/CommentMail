# CommentMail for LinkedIn

**CommentMail: Extract emails from LinkedIn® comments—built for recruiters.**

## What You Need (to make it work)

Nothing to install beyond the extension. You only need:

1. **Chrome** (or a Chromium-based browser that supports extensions).
2. **A LinkedIn account** — you must be logged in and on a post page.
3. **The post URL** — open the specific post (e.g. `linkedin.com/feed/update/...` or `linkedin.com/posts/...`) and click Start Scan.

For very large threads (4000+ comments), use the **backend** script in the `backend/` folder so it runs in the background on your machine without keeping the tab focused.

---

## Description
CommentMail extracts email addresses from LinkedIn® post comments and their replies. It is built for recruiters, and also useful for sales professionals and researchers who need to gather contact information from public LinkedIn discussions.

**New in v1.2:** Intercepts LinkedIn comment API responses via an injector (fetch/XHR wrap in the page) so all comment data is captured and parsed for emails — including **multiple emails per comment** and variants like "email @ domain.com".

## Features
*   **Turbo Mode Extraction:** Captures emails directly from LinkedIn's API responses (JSON) rather than scraping visible text.
*   **Privacy Safe:** No automated profile visiting or account-risking behavior. It simply "listens" to the data LinkedIn is already sending to your browser.
*   **CSV Export:** Download a clean CSV file with Email, Name, Profile Link, Comment Snippet, and Timestamp.
*   **Reply Expansion:** Clicks only **"View X replies"** and **"Load more comments"** to expand threads. It never clicks the **Reply** button or focuses the comment box, so it does not write replies or tag people.
*   **Duplicate Removal:** Automatically deduplicates emails found in the same session.
*   **Session Persistence:** Closing the side panel doesn't lose your data (until you click Refresh).

## How it Works (Technical)
1.  **API Interception:** When you start a scan, an injector script wraps fetch/XHR in the page so LinkedIn's comment API responses (`/voyager/api/feed/comments`, `/voyager/api/graphql`, etc.) are captured and parsed — so you see **Requests Intercepted** go up and emails from API data, not just the DOM. Every email in each comment is extracted (multiple per comment when present).
2.  **Triggering:** The content script clicks only "Load more comments" and "View X replies" (never the Reply button) so LinkedIn loads more data; the injector captures the responses.
3.  **Fallback:** If no API responses are captured (e.g. LinkedIn changed endpoints), the extension falls back to scraping visible comment DOM and mailto links.
4.  **Export:** Results are deduplicated and exported to CSV with email, author name, profile URL, and optional context.

---

## Efficiency and scale (how pros do it)

Tools like PhantomBuster and Apify run **headless browsers on their servers** and often use:

- **Session cookies** (we use a saved browser profile or the tab’s session).
- **Multi-pass loading:** Keep clicking "Load more" / "View replies" and **scrolling the comments area** so new buttons appear (LinkedIn lazy-loads). We do multiple passes and scroll so we don’t stop after the first batch.
- **Rate limiting** so LinkedIn doesn’t block the session.

**What we do for 4000+ comments:**

- **Extension:** Several passes of "Load more" and "View replies," with scrolling so more buttons load. Author names come from API (multiple paths + `included` lookup) and from the DOM (profile link text, `comments-comment-meta__description-title`), with obfuscated strings filtered out so you don’t get "Unknown User" or code-like names.
- **Backend script (`backend/`):** For “view more and all comments in background, then scrape” (like PhantomBuster): run the Node + Puppeteer script. It starts a **headless browser**, loads the post, clicks “Load more” / “View replies” in a loop until everything is loaded, then scrapes. All of that happens in the background on your PC — no tab to keep open. See `backend/README.md` for how it mirrors PhantomBuster’s approach.

---

## 🚀 Installation (Load Unpacked)

Since this is a developer build, you need to load it manually:

1.  **Download/Clone** this project folder to your computer.
2.  Open Chrome and navigate to `chrome://extensions`.
3.  Enable **Developer mode** (toggle in the top right corner).
4.  Click **Load unpacked**.
5.  Select the `linkedin-email-harvester` folder (the one containing `manifest.json`).
6.  The extension **CommentMail for LinkedIn** should appear.

---

## 📖 How to Use

1.  **Navigate to a LinkedIn Post**
    *   Go to any LinkedIn feed post (URL looks like `linkedin.com/feed/update/...` or `linkedin.com/posts/...`).
    *   *Note: It must be a specific post page, not the general feed.*

2.  **Open the Side Panel**
    *   Click the extension icon (envelope/logo) in your Chrome toolbar.
    *   The side panel will open on the right.

3.  **Start Scanning**
    *   Click the **Start Scan** button.
    *   **Do not interact with the page** while scanning is in progress. The extension will:
        *   **Switch to "Most recent"** (so all comments can be loaded, not just ~600 in "Most relevant").
        *   Expand "see more" on truncated comments.
        *   Click "Load more comments" repeatedly to fetch the whole thread.
        *   Expand replies.
        *   Extract emails and metadata.
    *   You can watch the progress live in the side panel dashboard.

4.  **Export Data**
    *   Once finished (or stopped), click **Download CSV** to save the results.
    *   Or use "Copy All" to copy emails to your clipboard.

---

## 🔒 Permissions Explained

*   `sidePanel`: To display the persistent UI next to the page.
*   `scripting`: To inject the extraction logic only when you start a scan.
*   `activeTab`: To access the current LinkedIn page content.
*   `downloads`: To save the generated CSV file.
*   `Host: linkedin.com`: To allow the extension to run on LinkedIn pages.

---

## ❓ Troubleshooting

*   **"No emails found"**: Ensure the comments actually contain visible emails (text or mailto links). If LinkedIn changed their HTML structure, the selectors might need an update.
*   **"Invalid URL"**: Make sure you are on a single post permalink page, not the main home feed.
*   **Scan stops at 605 / 4026 (or similar)**  
    LinkedIn only sends more comments when the page requests them. The extension clicks "Load more comments" and "View X replies" and scrolls the comments area so new batches load. If it stops early, common causes are: (1) **"Load more" disappears** until you scroll the list to the bottom — the extension now scrolls more aggressively and retries more times. (2) **Tab or window not focused** — keep the LinkedIn tab in the foreground so the page can load. (3) **LinkedIn rate-limiting** — if you hit 4k+ comments, use the **backend** script (`backend/` folder): it runs in a headless browser and can run longer without the tab. For maximum coverage on very large threads, run `node scrape-post.js "<post URL>"` after a one-time `npm run login` in the backend folder.
*   **Scan stops early (general)**: If the network is slow or LinkedIn rate-limits the "Load more" clicks, the scan might pause. You can resume or restart.
*   **Script Error**: Check the console (F12) for any "Context Invalidated" errors. This happens if the extension reloaded while the page was open. Refresh the page.
*   **Accuracy:** The extension extracts **all** emails from each comment (including multiple addresses in one comment, e.g. "a@x.com b@y.com") and normalizes space around `@` (e.g. "name @ domain.com"). If you see a lower count than a PDF or AI analysis, ensure "Include replies" and "Auto-load more comments" are on and that the scan completed fully.

---

## Extension vs. Backend (Phantombuster, etc.)

This tool is a **browser extension**: it runs inside your Chrome tab while you’re on LinkedIn. It does not run on a remote server.

**What this extension does:**  
Uses your existing LinkedIn session to read the post and comments (via interception or DOM), then exports emails to CSV. No separate server or login is needed.

**What tools like Phantombuster do:**  
They run in the **backend**: a browser (or API) runs on *their* servers. You give them a post URL (and often connect your LinkedIn account via cookie/session). They scrape in the cloud and return data. That’s a different architecture: server-side automation, not an extension.

**Can you “do everything in the backend” like Phantombuster?**  
- **With this repo alone:** No. An extension has no backend; it only runs in the user’s browser.  
- **To get backend-style behavior:** You’d add a separate service (e.g. Node.js + Puppeteer, or n8n + PhantomBuster/Apify) that receives a post URL, runs a headless browser with a LinkedIn session, and returns commenter/email data. This extension could then *optionally* send the current post URL to that backend and get backend-style behavior: this repo includes a **local backend** in the `backend/` folder (Node.js + Puppeteer). See `backend/README.md` for background scraping without manual clicking.
