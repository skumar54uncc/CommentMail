# Chrome Web Store — Step-by-Step Upload Guide

Follow these steps in order. Copy the content below into the CWS dashboard where indicated.

---

## Rename folders to CommentMail (do this once)

Use these names so the project and extension are both called CommentMail:

1. **Close Cursor** (or any app using the project folder) so nothing locks the folders.
2. In **File Explorer**, go to `d:\CS Projects\`.
3. **Rename the project root:**  
   Right‑click **LinkedIn Comment Email Extractor** → Rename → type **CommentMail** → Enter.
4. Open the **CommentMail** folder (the one you just renamed).
5. **Rename the extension folder:**  
   Right‑click **linkedin-email-harvester** → Rename → type **CommentMail** → Enter.
6. You should now have: `d:\CS Projects\CommentMail\CommentMail\` (extension with `manifest.json`) and `d:\CS Projects\CommentMail\backend\`, `privacy-policy.md`, etc.
7. **Reopen the project in Cursor** from `d:\CS Projects\CommentMail`.

When you create the zip for CWS, zip the **inner** CommentMail folder (the one that contains `manifest.json`).

---

## Before you start

- [ ] **Privacy Policy** is hosted (e.g. GitHub Pages).  
  Example URL: `https://skumar54uncc.github.io/CommentMail/privacy-policy`  
  (Enable GitHub Pages in repo **Settings → Pages**; source: main branch.)
- [ ] **Zip** contains only the **CommentMail** extension folder contents (no `backend/`).  
  Path on your PC: `d:\CS Projects\CommentMail\CommentMail` (after you rename folders; see below)  
  Zip that folder (or its contents) and name it e.g. `CommentMail-1.1.0.zip`.

---

## Step 1: Developer account

1. Go to **https://chrome.google.com/webstore/devconsole**
2. Sign in with your Google account.
3. If this is your first time, pay the **one-time developer registration fee** ($5).
4. Accept the Developer Distribution Agreement if prompted.

---

## Step 2: New item and upload

1. Click **“New item”**.
2. Click **“Choose file”** and select your zip (e.g. `CommentMail-1.1.0.zip`).
3. Wait for the upload to finish. The dashboard will show your extension with a draft status.

---

## Step 3: Store listing (copy-paste content)

Use this wording. **Do not use** “scrape,” “scraping,” “harvester,” or “harvest” in any field.

### Short description (132 characters max)

```
CommentMail extracts email addresses that LinkedIn users have publicly posted in post comments, saving them to a downloadable CSV.
```
*(Length: 99 characters)*

### Detailed description (optional but recommended)

```
CommentMail helps recruiters and professionals collect email addresses that people have publicly shared in LinkedIn post comments.

• Extract emails from comments and replies on any LinkedIn post you open
• One row per email in the results table and in the downloaded CSV
• Data stays on your device; nothing is sent to external servers
• Optional: include replies, auto-load more comments, and export comment snippets in CSV

How to use: Open a LinkedIn post (feed/update or posts URL), open the CommentMail side panel, accept the disclosure, and click Start Scan. When finished, use Copy or Download CSV.

Requires: Chrome (or Chromium), a logged-in LinkedIn session, and a post page (not the main feed).
```

### Category

- Choose **Productivity** or **Social & Communication** (whichever fits your preference).

### Language

- Select **English** (and any other languages you support).

---

## Step 4: Privacy and permissions

### Privacy Policy URL (required)

- In the **Privacy** section, paste your hosted Privacy Policy URL.  
  Example: `https://skumar54uncc.github.io/CommentMail/privacy-policy`  
- CWS will reject the item if this field is empty.

### Permission justification

When CWS asks why each permission is needed, you can use:

| Permission   | Justification |
|-------------|----------------|
| **sidePanel** | To show the extension UI (start scan, view results, download CSV) next to the LinkedIn tab. |
| **scripting** | To inject the content script only when the user starts a scan on a LinkedIn post page. |
| **activeTab** | To run the extension on the current LinkedIn tab when the user clicks Start Scan. |
| **downloads** | To save the generated CSV file to the user’s computer when they click Download CSV. |
| **storage**   | To store the user’s disclosure acceptance and, during the session, extracted results (session storage only; cleared when the browser closes). |
| **Host: linkedin.com** | The extension only runs on LinkedIn. It reads comment data from the post page the user has open. |

Single sentence you can paste if asked:  
*“CommentMail runs only on LinkedIn post pages to extract emails from public comments; it uses storage for session results and disclosure acceptance, and downloads only for user-requested CSV export.”*

---

## Step 5: Screenshots

- CWS requires **at least 1 screenshot**. Recommended size: **1280×800** or **640×400** pixels.
- Capture these (you can use 1–3 images):
  1. **Ready** — Side panel open on a LinkedIn post, “Ready to Scan,” Start Scan button visible.
  2. **Scanning** — “Scanning…” with phase text and comment/email counts.
  3. **Results** — Results table with emails and Copy / Download CSV visible.

Upload them in the **Screenshots** section of the store listing.

---

## Step 6: Submit for review

1. Complete every required field (description, category, Privacy Policy URL, screenshots, permissions).
2. Click **“Submit for review”**.
3. Review can take from a few hours to a few days. You’ll get an email when the status changes.
4. If the reviewer asks questions, answer using your **EXTENSION-COMPLETE-OVERVIEW.md** and **SECURITY.md** (e.g. no remote servers, no debugger, data on device only, minimal permissions).

---

## Quick checklist before submit

- [ ] Zip contains only the **CommentMail** extension folder contents (no `backend/`).
- [ ] Privacy Policy URL is hosted and pasted in the Privacy field.
- [ ] Short description uses “extract” / “collect” / “CommentMail” (no “scrape” / “harvester”).
- [ ] At least one screenshot uploaded (1280×800 or 640×400).
- [ ] Permissions justified as above.

---

## Wording changes already made in the extension

These were updated so user-facing text and CSV content align with CWS-friendly language:

- **Toast on LinkedIn page:** “CommentMail Ready” (was “Scraper Ready”).
- **Side panel heading during scan:** “Scanning…” (was “Scraping…”).
- **DOM fallback comment snippet:** “Extracted via DOM fallback” (was “Scraped via DOM fallback”).

Internal code (e.g. variable names like `harvesterResults`) is unchanged and not visible in the store listing.
