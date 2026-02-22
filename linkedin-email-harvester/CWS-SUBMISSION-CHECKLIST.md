# Chrome Web Store — Submission Checklist

Use this when packaging the extension for CWS. **Two hard blockers** must be done before submit.

---

## Hard blocker 1: Privacy Policy URL

- CWS **rejects** the submission if the Privacy Policy URL field is empty.
- **Do this first:**
  1. Use the repo’s `privacy-policy.md` (in project root) or copy its content.
  2. In your GitHub repo: enable **GitHub Pages** (Settings → Pages → source: main branch, folder: / (root) or /docs).
  3. If the policy is at repo root as `privacy-policy.md`, the URL is:  
     `https://[username].github.io/[repo-name]/privacy-policy`  
     (GitHub Pages often serves .md as HTML; if not, use an `index.html` in a `/privacy` folder with the same content.)
  4. In the **Chrome Web Store Developer Dashboard**, in your item’s **Privacy** section, paste this URL.

---

## Hard blocker 2: Submission zip must NOT include backend/

- The **backend/** folder (Node + Puppeteer script) must **not** be in the zip you upload to CWS.
- CWS reviewers and automated checks may treat a headless Puppeteer script with user data directory as high-risk and can reject or escalate the item.

**Safe option — zip only the extension folder:**

- Zip **only** the contents of the **`linkedin-email-harvester`** folder (the folder that contains `manifest.json`).
- That folder does not contain `backend/` (backend lives in the parent repo). So zipping `linkedin-email-harvester` alone is safe.

**If you zip the whole project:**

- You **must** exclude:
  - `backend/` (entire folder)
  - `.git/`
  - `node_modules/`
  - Any other non-extension files (e.g. `privacy-policy.md` is for hosting, not for the zip).

**Exact files to include in the zip (all inside `linkedin-email-harvester`):**

```
manifest.json
background.js
content.js
injector.js
sidepanel.html
sidepanel.css
sidepanel.js
icons/          (folder with icon16.png, icon48.png, icon128.png)
```

Optional but fine to include: `README.md`, `SECURITY.md`, `SCRAPING-ARCHITECTURE.md`, `EXTENSION-COMPLETE-OVERVIEW.md`, `CWS-SUBMISSION-CHECKLIST.md` (they help reviewers and are not executable). Do **not** include any backend or parent-level files.

---

## Store listing copy (recommended)

- **Do not use** in the CWS listing: “scrape,” “scraping,” “harvester,” “harvest.”
- **Use instead:** “extract,” “collect,” “CommentMail” (brand name).

**Single-purpose statement (for short description):**

> CommentMail extracts email addresses that LinkedIn users have publicly posted in post comments, saving them to a downloadable CSV.

---

## Screenshots (required)

- CWS requires at least **1 screenshot**. Recommended: **1280×800** or **640×400**.
- Capture:
  1. **Ready state** — side panel on a LinkedIn post, “Ready to Scan.”
  2. **Scanning state** — “Scraping…”, phase text, comments/emails counts.
  3. **Results state** — table with emails, Copy / Download CSV visible.

---

## After both blockers are done

1. Developer account + one-time fee (if not done).
2. Privacy Policy hosted; URL added in CWS dashboard.
3. Zip created from `linkedin-email-harvester` only (no backend).
4. New item → upload zip → description, category, screenshots, Privacy URL, permission justification.
5. Submit for review.

See **EXTENSION-COMPLETE-OVERVIEW.md** for full readiness, architecture, and security summary.
