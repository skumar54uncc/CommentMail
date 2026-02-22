#!/usr/bin/env node
/**
 * LinkedIn Post Commenters Scraper (Background / Headless)
 * Runs on YOUR machine with Puppeteer — like PhantomBuster but local.
 * No manual clicking; script does "Load more" / "View replies" automatically.
 *
 * Prerequisites: Node.js 18+, one-time login (see README).
 * Usage:
 *   npm run login          # One-time: open LinkedIn, you log in, then close
 *   node scrape-post.js "https://www.linkedin.com/feed/update/urn:li:activity:..."
 */

import puppeteer from "puppeteer";
import { createWriteStream } from "fs";
import { join } from "path";

const USER_DATA_DIR = join(process.cwd(), ".linkedin-browser-profile");
// --- FIX 3: PUPPETEER UPGRADES ---
const LOAD_MORE_WAIT_MS = 1500;   // max fallback only (event-driven wait moves on earlier)
const REPLY_EXPAND_WAIT_MS = 1000; // max fallback only
const MAX_LOAD_MORE_CLICKS = 5000;
const MAX_REPLY_CLICKS = 8000;
const IDLE_ROUNDS = 10;
const SCROLL_EVERY_N_IDLE = 3;

// --- Parser (same logic as extension) ---
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

function normalizeEmail(email) {
  const clean = email.toLowerCase().replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, "");
  if (clean.length > 254) return null;
  const badTLDs = ["png", "jpg", "gif", "svg", "mp4", "pdf", "zip"];
  const tld = clean.split(".").pop();
  if (badTLDs.includes(tld)) return null;
  return clean;
}

function extractEmailFromText(text) {
  if (!text) return null;
  if (text.includes("mailto:")) {
    const potential = text.split("mailto:")[1]?.split(/[\s?"]/)[0];
    if (potential?.includes("@")) return normalizeEmail(potential);
  }
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex);
  if (matches?.length) return normalizeEmail(matches[0]);
  return null;
}

function parseCommentItem(item, postUrl) {
  const text = resolveField(
    item,
    "commentV2.text",
    "commentary.text",
    "message.text",
    "text.text",
    "comment.values.0.value"
  );
  if (!text) return null;
  const email = extractEmailFromText(text);
  if (!email) return null;
  let authorName = resolveField(
    item,
    "commenter.com.linkedin.voyager.feed.MemberActor.name.text",
    "commenter.actor.name.text",
    "actor.name.text",
    "author.name.text",
    "commenter.name.text"
  );
  if (!authorName) {
    const first = resolveField(item, "commenter.miniProfile.firstName", "actor.miniProfile.firstName");
    const last = resolveField(item, "commenter.miniProfile.lastName", "actor.miniProfile.lastName");
    if (first || last) authorName = [first, last].filter(Boolean).join(" ").trim();
  }
  authorName = (authorName && String(authorName).trim()) || "Unknown User";
  if (/^[a-zA-Z0-9._-]{2,}$/.test(authorName) && authorName.length > 20 && !/\s/.test(authorName))
    authorName = "Unknown User";
  let authorTitle = resolveField(
    item,
    "commenter.com.linkedin.voyager.feed.MemberActor.description.text",
    "commenter.actor.headline",
    "actor.headline",
    "commenter.miniProfile.occupation",
    "actor.occupation"
  );
  authorTitle = (authorTitle && String(authorTitle).trim()) || "";
  let profileUrl = resolveField(
    item,
    "commenter.com.linkedin.voyager.feed.MemberActor.navigationUrl",
    "commenter.com.linkedin.voyager.feed.MemberActor.miniProfile.publicIdentifier",
    "commenter.actor.navigationUrl",
    "commenter.actor.miniProfile.publicIdentifier",
    "actor.miniProfile.publicIdentifier"
  );
  if (profileUrl && !profileUrl.startsWith("http"))
    profileUrl = `https://www.linkedin.com/in/${profileUrl}`;
  return {
    email,
    authorName,
    authorTitle,
    linkedinProfileUrl: profileUrl || "",
    postUrl,
    extractedAtISO: new Date().toISOString(),
    commentSnippet: text.substring(0, 100),
    sourceType: "comment",
    seenCount: 1,
  };
}

function parsePayload(payload, postUrl) {
  const records = [];
  let commentCandidates = [];
  if (payload.elements?.length) commentCandidates.push(...payload.elements);
  if (payload.data?.elements?.length)
    commentCandidates.push(...payload.data.elements);
  if (payload.included?.length) commentCandidates.push(...payload.included);
  const nested = [];
  for (const item of commentCandidates) {
    if (item?.comments?.elements?.length)
      nested.push(...item.comments.elements);
    if (item?.socialDetail?.comments?.elements?.length)
      nested.push(...item.socialDetail.comments.elements);
  }
  commentCandidates = commentCandidates.concat(nested);
  for (const item of commentCandidates) {
    if (!item) continue;
    const urn = item.entityUrn || item.urn || "";
    const type = item.$type || "";
    const isComment =
      urn.includes("urn:li:comment") ||
      urn.includes("urn:li:fsd_comment") ||
      type.includes("Comment");
    if (isComment) {
      const record = parseCommentItem(item, postUrl);
      if (record) records.push(record);
    }
  }
  return records;
}

// --- CSV ---
function escapeCsv(str) {
  if (str == null) return '""';
  const s = String(str).replace(/"/g, '""').replace(/\n/g, " ");
  return `"${s}"`;
}

function writeCsv(records, outPath) {
  const headers = [
    "email",
    "author_name",
    "author_title",
    "linkedin_profile_url",
    "post_url",
    "extracted_at_iso",
    "comment_snippet",
    "source_type",
    "seen_count",
  ];
  const stream = createWriteStream(outPath, { encoding: "utf8" });
  stream.write(headers.join(",") + "\n");
  for (const r of records) {
    const row = [
      escapeCsv(r.email),
      escapeCsv(r.authorName || "Unknown"),
      escapeCsv(r.authorTitle || ""),
      escapeCsv(r.linkedinProfileUrl || ""),
      escapeCsv(r.postUrl || ""),
      escapeCsv(r.extractedAtISO || ""),
      escapeCsv(r.commentSnippet || ""),
      escapeCsv(r.sourceType || ""),
      r.seenCount ?? 1,
    ].join(",");
    stream.write(row + "\n");
  }
  stream.end();
  return outPath;
}

// --- In-page click logic: click-first (minimal scroll for speed) ---
const clickScript = (scrollThisRound) => {
  const isVisible = (el) =>
    !!(el?.offsetWidth || el?.offsetHeight || el?.getClientRects?.()?.length);

  const scrollCommentsDown = () => {
    const list = document.querySelector(".comments-comments-list, [class*='comments-list']");
    if (list) list.scrollTop = list.scrollHeight;
  };

  const findLoadMore = () => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.find(
      (b) =>
        isVisible(b) && /load\s*more\s*comments/i.test((b.innerText || b.getAttribute("aria-label") || ""))
    );
  };

  const findExpandReplies = () => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.filter((b) => {
      if (!isVisible(b)) return false;
      const text = (b.textContent || b.getAttribute("aria-label") || "").trim();
      if (/^\s*reply\s*$/i.test(text)) return false;
      if (/view\s+\d+\s+repl/i.test(text)) return true;
      if (/see\s+(previous|more)\s+repl/i.test(text)) return true;
      if (/\d+\s+repl/i.test(text)) return true;
      return false;
    });
  };

  let btn = findLoadMore();
  if (btn) {
    btn.scrollIntoView({ behavior: "auto", block: "center" });
    btn.click();
    return "load_more";
  }
  if (scrollThisRound) scrollCommentsDown();
  const replyBtns = findExpandReplies();
  const unclicked = replyBtns.filter((b) => !b.dataset.harvesterClicked);
  if (unclicked.length > 0) {
    const b = unclicked[0];
    b.dataset.harvesterClicked = "1";
    b.scrollIntoView({ behavior: "auto", block: "center" });
    b.click();
    return "view_replies";
  }
  return "none";
};

// --- DOM fallback: scrape visible comments for emails ---
const domFallbackScript = () => {
  const emailRegex =
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const normalize = (e) =>
    e
      .toLowerCase()
      .replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, "")
      .replace(/(png|jpg|gif|svg|mp4|pdf|zip)$/i, "xxx");
  const containers = document.querySelectorAll('[data-id^="urn:li:comment:"]');
  const results = [];
  const seen = new Set();
  for (const container of containers) {
    const text = container.textContent || "";
    const profileLink = container.querySelector("a[href*='/in/']");
    let profileUrl = profileLink?.getAttribute("href")?.split("?")[0] || "";
    if (profileUrl && !profileUrl.startsWith("http"))
      profileUrl = (typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://www.linkedin.com") + (profileUrl.startsWith("/") ? profileUrl : "/" + profileUrl);
    let authorName = "Unknown";
    if (profileLink) {
      const t = (profileLink.textContent || "").trim();
      if (t && t.length < 80 && (/\s/.test(t) || t.length < 50)) authorName = t;
    }
    if (authorName === "Unknown") {
      const titleEl = container.querySelector("span.comments-comment-meta__description-title");
      const t = (titleEl?.textContent || "").trim();
      if (t && t.length < 80 && !/^[a-zA-Z0-9._-]{25,}$/.test(t)) authorName = t;
    }
    if (authorName === "Unknown") {
      const aria = container.querySelector("[aria-label]");
      const t = (aria?.getAttribute("aria-label") || "").trim();
      if (t && t.length < 80) authorName = t;
    }
    const titleSub = container.querySelector("span.comments-comment-meta__description-subtitle");
    const authorTitle = (titleSub?.textContent || "").trim().substring(0, 200) || "";
    for (const a of container.querySelectorAll('a[href^="mailto:"]')) {
      const href = (a.getAttribute("href") || "").replace(/^mailto:/i, "").trim();
      const potential = href.split(/[\s?"]/)[0];
      if (potential?.includes("@")) {
        const email = normalize(potential);
        if (email && !seen.has(email)) {
          seen.add(email);
          results.push({
            email: potential,
            authorName,
            authorTitle,
            linkedinProfileUrl: profileUrl,
            commentSnippet: "DOM fallback",
          });
        }
      }
    }
    const matches = text.match(emailRegex) || [];
    for (const m of matches) {
      const email = normalize(m);
      if (email && email.length < 255 && !seen.has(email)) {
        seen.add(email);
        results.push({
          email: m,
          authorName,
          authorTitle,
          linkedinProfileUrl: profileUrl,
          commentSnippet: text.substring(0, 100).replace(/\s+/g, " "),
        });
      }
    }
  }
  return results;
};

async function main() {
  const args = process.argv.slice(2);
  const loginOnly = args.includes("--login");
  const postUrl = args.find((a) => a.startsWith("http") && a.includes("linkedin"));

  if (loginOnly) {
    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: USER_DATA_DIR,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await new Promise((resolve) => process.stdin.once("data", resolve));
    await browser.close();
    return;
  }

  if (!postUrl) {
    console.error("Usage: node scrape-post.js \"https://www.linkedin.com/feed/update/urn:li:activity:...\"");
    console.error("One-time login: node scrape-post.js --login");
    process.exit(1);
  }

  const emailMap = new Map();
  let interceptedCount = 0;

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "media", "font", "stylesheet", "ping", "prefetch"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
  await page.setViewport({ width: 1280, height: 800 });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Intercept API responses (like the extension's injector)
  page.on("response", async (response) => {
    const url = response.url();
    if (
      !url.includes("/voyager/api/feed/comments") &&
      !url.includes("/voyager/api/social-actions") &&
      !url.includes("/voyager/api/feed/updates") &&
      !url.includes("/voyager/api/graphql")
    )
      return;
    try {
      const bodyStr = await response.text();
      if (!bodyStr.includes("@") && !bodyStr.includes("mailto:")) return;
      const body = JSON.parse(bodyStr);
      const records = parsePayload(body, postUrl);
      interceptedCount += 1;
      for (const r of records) {
        if (!emailMap.has(r.email)) {
          emailMap.set(r.email, { ...r, postUrl });
        } else {
          const existing = emailMap.get(r.email);
          existing.seenCount = (existing.seenCount || 1) + 1;
        }
      }
      if (records.length > 0)
        process.stdout.write(`\rIntercepted: ${interceptedCount} responses, ${emailMap.size} unique emails so far.`);
    } catch (_) {}
  });

  await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 60000 });

  await page.evaluate(() => {
    const el =
      document.querySelector(".comments-comments-list") ||
      document.querySelector("[class*='comments-list']") ||
      document.querySelector(".social-details-social-activity");
    if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
  });
  await new Promise((r) => setTimeout(r, 1000));

  let idleCount = 0;
  let loadMoreClicks = 0;
  let replyClicks = 0;

  while (idleCount < IDLE_ROUNDS) {
    const scrollThisRound = idleCount > 0 && idleCount % SCROLL_EVERY_N_IDLE === 0;
    let responseHandler;
    const commentResponsePromise = new Promise((resolve) => {
      responseHandler = (res) => {
        if (res.url().includes("/voyager/api/feed/comments")) {
          page.off("response", responseHandler);
          resolve();
        }
      };
      page.on("response", responseHandler);
    });
    const result = await page.evaluate(clickScript, scrollThisRound);
    if (result === "none") {
      idleCount++;
      page.off("response", responseHandler);
      await sleep(350);
      continue;
    }
    idleCount = 0;
    if (result === "load_more") loadMoreClicks++;
    if (result === "view_replies") replyClicks++;
    await Promise.race([
      commentResponsePromise,
      sleep(1500).then(() => {
        try { page.off("response", responseHandler); } catch (_) {}
      }),
    ]);
    if (loadMoreClicks >= MAX_LOAD_MORE_CLICKS && replyClicks >= MAX_REPLY_CLICKS)
      break;
  }

  const domRecords = await page.evaluate(domFallbackScript);
  const postUrlFinal = postUrl;
  for (const r of domRecords) {
    const email = normalizeEmail(r.email);
    if (!email) continue;
    if (!emailMap.has(email)) {
      emailMap.set(email, {
        email,
        authorName: r.authorName || "Unknown",
        authorTitle: r.authorTitle || "",
        linkedinProfileUrl: r.linkedinProfileUrl || "",
        postUrl: postUrlFinal,
        extractedAtISO: new Date().toISOString(),
        commentSnippet: (r.commentSnippet || "DOM fallback").replace(/\s+/g, " "),
        sourceType: "fallback",
        seenCount: 1,
      });
    }
  }

  await browser.close();

  const records = Array.from(emailMap.values());
  const outPath = join(
    process.cwd(),
    `linkedin-commenters-${Date.now()}.csv`
  );
  writeCsv(records, outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
