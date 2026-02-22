// background.js - Service Worker
// Handles side panel opening, message relaying, downloads.
// Interception: injector (MAIN world) only — no debugger (CWS compliance).
// Fixed: [3]

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

// FIX BUG 1: store LinkedIn tab ID so getResults targets the correct tab
let activeTabId = null;

function isLinkedInPostUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^([a-zA-Z0-9-]+\.)*linkedin\.com$/.test(u.hostname)) {
      return false;
    }
    const validPaths = [
      /^\/feed\/update\//,
      /^\/posts\//,
      /^\/pulse\//,
      /^\/in\/[^/]+\/recent-activity/,
    ];
    return validPaths.some(pattern => pattern.test(u.pathname));
  } catch {
    return false;
  }
}

/**
 * Open the side panel when the extension action icon is clicked.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

/**
 * Message Relay & Action Handler
 * MV3 forbids direct communication between sidepanel and content script.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startScan') {
    handleStartScan(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('Start scan failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'stopScan') {
    forwardMessageToActiveTab(message);
    return false;
  }

  if (message.action === 'syncResults') {
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }

  if (message.action === 'downloadCSV') {
    handleDownloadCSV(message);
    return false;
  }

  if (message.action === 'getResults') {
    const tabId = activeTabId;
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { action: 'getResults' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ results: [] });
          return;
        }
        const list = response && Array.isArray(response.results) ? response.results : [];
        sendResponse({ results: list });
      });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) {
          sendResponse({ results: [] });
          return;
        }
        chrome.tabs.sendMessage(tab.id, { action: 'getResults' }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ results: [] });
            return;
          }
          const list = response && Array.isArray(response.results) ? response.results : [];
          sendResponse({ results: list });
        });
      });
    }
    return true;
  }

  if (message.action === 'ping') {
    sendResponse('pong');
    return false;
  }

  if (message.action === 'keepAlive') {
    sendResponse({ alive: true });
    return false;
  }
});

async function handleStartScan(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tabId = message.tabId || (tab ? tab.id : null);
  let url = message.url || (tab ? tab.url : null);

  activeTabId = tabId;

  if (!isLinkedInPostUrl(url)) {
    throw new Error('Please navigate to a LinkedIn post URL to start scanning. (linkedin.com/feed/update/... or linkedin.com/posts/...)');
  }

  const nonce = crypto.randomUUID();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (n) => { window.__harvesterNonce = n; },
      args: [nonce],
      world: "MAIN"
    });
  } catch (e) {}
  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["injector.js"],
        world: "MAIN"
      });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : "";
      if (!msg.includes("already") && e.code !== 1) throw e;
    }

    try {
      await chrome.tabs.sendMessage(tabId, { action: "ping" });
    } catch (_) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
          world: "ISOLATED"
        });
        await new Promise(r => setTimeout(r, 150));
      } catch (e2) {}
    }

    await new Promise(r => setTimeout(r, 300));
    await chrome.tabs.sendMessage(tabId, { ...message, nonce });
  } catch (err) {
    console.error("Injection/Connection failed:", err);
    throw new Error("Could not start scan. Refresh the LinkedIn tab (F5), close and reopen the side panel, then try again.");
  }
}

async function forwardMessageToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (err) {
    console.error('Forwarding failed:', err);
  }
}

function handleDownloadCSV(message) {
  if (!message || message.csvContent == null) return;
  const { csvContent, filename } = message;
  const blob = new Blob([String(csvContent)], { type: 'text/csv;charset=utf-8' });
  const reader = new FileReader();
  reader.onload = function () {
    chrome.downloads.download({
      url: reader.result,
      filename: filename || 'linkedin-emails.csv',
      saveAs: true
    });
  };
  reader.readAsDataURL(blob);
}
