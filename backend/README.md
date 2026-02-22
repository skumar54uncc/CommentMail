# LinkedIn Post Commenters — Background Scraper

This runs **on your machine in the background** (like PhantomBuster on their servers). No manual clicking: the script opens a headless browser, goes to the post, auto-clicks "Load more comments" / "View X replies" until everything is loaded, then scrapes and saves a CSV.

---

## How PhantomBuster Does It (and How We Do the Same)

**PhantomBuster’s approach:** They don’t use your browser tab. They run a **separate browser** on **their servers**. You give them the post URL (and your session, e.g. cookies). Their automation:

1. **Phase 1 — Load everything in the background:** That browser opens the post and their script clicks “Load more comments” and “View X replies” (and scrolls) in a loop. So inside that browser, all comments gradually appear, just like when you scroll and click yourself — but it happens on their server, in the background for you.
2. **Phase 2 — Scrape:** They either capture API responses as each “Load more” / “View replies” runs, or they scrape the DOM once everything is loaded (or both). Then they return the CSV.

**Our backend script does the same thing on your machine:**

1. **Phase 1 — Load all in background:** Puppeteer starts a **headless Chrome** process (no window, or you can show it). It goes to your post URL with your saved LinkedIn session and runs the same logic: click “Load more comments” and “View X replies” in a loop and scroll the comments area. So in that process, “view more” and all comments are loaded in the background — no need for you to keep a tab open or click anything.
2. **Phase 2 — Scrape:** We capture comment API responses as they come (`page.on('response')`), and at the end we run a DOM scrape over the loaded page. Results are deduped and written to CSV.

So yes: we **do** load all comments in the background (in a separate browser), then scrape. The only difference from PhantomBuster is that the “background” is a process on **your PC** (Node + Puppeteer) instead of their servers.

---

## What You Need to Provide

| Requirement | What to do |
|-------------|------------|
| **Node.js 18+** | Install from [nodejs.org](https://nodejs.org). Run `node -v` to confirm. |
| **One-time LinkedIn login** | Run `npm run login` once. A browser opens; log in to LinkedIn, then close the window or press Enter in the terminal. Your session is saved in `.linkedin-browser-profile/`. |
| **Post URL** | When scraping: pass the full post URL, e.g. `https://www.linkedin.com/feed/update/urn:li:activity:7375955827536543744` |

Nothing else. No API keys, no PhantomBuster account, no cloud.

---

## Quick Start

```bash
cd backend
npm install

# One-time: save your LinkedIn session
npm run login

# Scrape a post (replace with your post URL)
node scrape-post.js "https://www.linkedin.com/feed/update/urn:li:activity:YOUR_ACTIVITY_ID"
```

Output: `linkedin-commenters-<timestamp>.csv` in the `backend/` folder.

---

## Why This Can Do “Everything in Background” (Like PhantomBuster)

- **PhantomBuster:** Their servers run a browser; you give a post URL and (optionally) connect your account. They click through and scrape on their infrastructure.
- **This script:** Your machine runs Puppeteer (headless Chrome). You give a post URL. The script uses your saved LinkedIn session, clicks through automatically, and intercepts API responses + DOM. It runs in the **background on your PC** (you can minimize the terminal and do other work).

So: same idea as PhantomBuster, but the “backend” is your own computer. No manual clicking in a tab; the script does it. For 4000 comments it may take 15–30 minutes depending on network and LinkedIn’s rate limits, but it’s fully automated.

---

## PhantomBuster setup reference

If you're used to PhantomBuster's "LinkedIn Post Commenters Export" phantom, here's how our script lines up:

| PhantomBuster | This script |
|---------------|-------------|
| **Session Cookie** | We use a **saved browser profile** (run `npm run login` once). Same idea: reuse your LinkedIn session. |
| **Post URL** | Same: pass the full post URL as the argument. |
| **Extract Threads Replies** | Same: we auto-click "View X replies" and "Load more comments" so we get nested replies. |
| **Watcher Mode** | We do a **one-off run** per command. Run again when you need an updated export. |
| **CSV output** | Same: we write a CSV with profile link, name, email when found, etc. |

PhantomBuster can do ~4000 commenters in a few minutes on their servers; locally, expect longer (e.g. 15-30 min) depending on your connection.

---

## Options

- **Headless:** By default the browser runs headless (no window). To watch it run, edit `scrape-post.js` and set `headless: false` in `puppeteer.launch()`.
- **Limits:** `MAX_LOAD_MORE_CLICKS` and `MAX_REPLY_CLICKS` in `scrape-post.js` cap how many “Load more” / “View replies” clicks are made. Increase them for very large threads.

---

## Troubleshooting

- **“Session expired” / not logged in:** Run `npm run login` again and log in to LinkedIn in the opened window.
- **No emails in CSV:** The post may have no comments with visible emails, or LinkedIn’s DOM/API may have changed (selectors can be updated in `scrape-post.js`).
- **Script hangs:** LinkedIn may show a captcha or limit requests. Try again later or run with a visible browser (`headless: false`) to see what’s on screen.
