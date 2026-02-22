// Fixed: [2]
/**
 * injector.js
 * INJECTED INTO MAIN WORLD (chrome.scripting.executeScript with world: "MAIN")
 * Intercepts window.fetch and XMLHttpRequest to capture LinkedIn Voyager API responses.
 * Has NO access to chrome.* APIs. Communicates ONLY via window.postMessage.
 * Nonce: set by background via window.__harvesterNonce before this script runs; included in every message for content validation.
 * CRITICAL: Always clone response before .json() so LinkedIn's React still gets the body.
 * nonce is read dynamically on each call — do not cache in closure
 */
(function () {
  try {
    if (window.__harvesterInjected) return;
    window.__harvesterInjected = true;

    if (!window.__harvesterBuffer) window.__harvesterBuffer = [];

    function sendIntercept(url, payload, bodyStr, csrfToken) {
      try {
        var bodySample = "";
        if (bodyStr && bodyStr.length > 0) {
          var len = bodyStr.length;
          bodySample = bodyStr.substring(0, 64) +
            (len > 128 ? bodyStr.substring(Math.floor(len / 2) - 32, Math.floor(len / 2) + 32) : "") +
            (len > 64 ? bodyStr.substring(len - 64) : "");
        }
        window.postMessage({ type: "__HARVESTER_INTERCEPT__", url, payload: payload, nonce: window.__harvesterNonce, bodySample: bodySample, csrfToken: csrfToken || null }, "*");
      } catch (e) {
        window.__harvesterBuffer.push({ url, payload });
      }
    }

    function sendReady() {
      try {
        window.postMessage({ type: "__HARVESTER_READY__", nonce: window.__harvesterNonce }, "*");
      } catch (e) {}
    }

    function isCommentRelatedUrl(url) {
      if (!url || typeof url !== "string") return false;
      return url.includes("/voyager/api/feed/comments") ||
        url.includes("/voyager/api/social-actions") ||
        url.includes("/voyager/api/feed/updates") ||
        url.includes("/voyager/api/graphql");
    }

    /** Two-stage: comment endpoints always parse (paging/URN); others require @/mailto to avoid noise. */
    function shouldParseBody(bodyStr, url) {
      if (url.includes("/voyager/api/feed/comments") ||
          url.includes("/voyager/api/social-actions") ||
          url.includes("/voyager/api/feed/updates") ||
          url.includes("/voyager/api/graphql")) return true;
      return (bodyStr && (bodyStr.includes("@") || bodyStr.includes("mailto:")));
    }

    if (typeof window.fetch === "function") {
      const _originalFetch = window.fetch;
      window.fetch = async function (...args) {
        var req = args[0];
        var csrf = (req && req.headers && typeof req.headers.get === "function") ? req.headers.get("csrf-token") : null;
        const response = await _originalFetch.apply(this, args);
        const url = (typeof args[0] === "string" ? args[0] : args[0]?.url) || "";
        if (isCommentRelatedUrl(url)) {
          try {
            response.clone().text().then(bodyStr => {
              if (!shouldParseBody(bodyStr, url)) return;
              try {
                const data = JSON.parse(bodyStr);
                sendIntercept(url, data, bodyStr, csrf);
              } catch (e) {}
            }).catch(() => {});
          } catch (e) {}
        }
        return response;
      };
    }

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__harvesterUrl = url;
      return _origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const url = this.__harvesterUrl || "";
          if (!isCommentRelatedUrl(url)) return;
          if (this.responseType !== "" && this.responseType !== "text") return;
          const bodyStr = this.responseText;
          if (!shouldParseBody(bodyStr, url)) return;
          const data = JSON.parse(bodyStr);
          sendIntercept(url, data, bodyStr, null);
        } catch (e) {
          return;
        }
      });
      return _origSend.apply(this, args);
    };

    window.addEventListener("message", function (e) {
      if (e.source !== window || e.data?.type !== "__HARVESTER_PING__") return;
      sendReady();
    });
    sendReady();
  } catch (e) {
    // Never break LinkedIn's page
  }
})();
