/**
 * utils.js - Shared utilities
 *
 * Minimal helper functions used by content.js
 */

const Utils = {
  /**
   * Log with prefix for easy filtering
   */
  log: function(...args) {
    console.log('[SSO]', ...args);
  },

  /**
   * Wait for specified milliseconds
   */
  sleep: function(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * Show a toast notification in the page corner.
   * Content scripts cannot call chrome.notifications.create() directly —
   * that API is only available in background service workers.
   * We render a small overlay div instead, which works on any page.
   * @param {string} title
   * @param {string} message
   */
  showNotification: function(title, message) {
    Utils.log(`[Notification] ${title}: ${message}`);
    try {
      // Remove any existing SSO toast
      const old = document.getElementById('__sso_toast__');
      if (old) old.remove();

      const toast = document.createElement('div');
      toast.id = '__sso_toast__';
      toast.style.cssText = [
        'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
        'background:#1a1a2e', 'color:#e0e0e0', 'padding:12px 18px',
        'border-radius:8px', 'font-family:sans-serif', 'font-size:13px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)', 'max-width:320px',
        'border-left:4px solid #4CAF50', 'line-height:1.5'
      ].join(';');
      toast.innerHTML = `<strong style="color:#4CAF50">${title}</strong><br>${message}`;
      document.body.appendChild(toast);

      // Auto-dismiss after 4 seconds
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
    } catch(e) {
      // Absolute fallback
      Utils.log('Toast render failed:', e.message);
    }
  },

  /**
   * Ask user for consent using a custom in-page dialog.
   * window.confirm() is suppressed by many external sites (Codeforces, LeetCode, etc.)
   * so we render our own modal and block with a Promise.
   * NOTE: Since enterLearningMode callers use this synchronously we keep the
   * Promise-compatible version; callers that need sync must use awaitConsent.
   * @param {string} message
   * @returns {boolean}  (sync fallback — works for callers that don't await)
   */
  askConsent: function(message) {
    // Sync best-effort: render a blocking custom confirm
    return Utils._syncConfirm(message);
  },

  /**
   * Async consent dialog — preferred over askConsent for new callers.
   * @param {string} message
   * @returns {Promise<boolean>}
   */
  askConsentAsync: function(message) {
    return new Promise(resolve => {
      try {
        const old = document.getElementById('__sso_confirm__');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = '__sso_confirm__';
        overlay.style.cssText = [
          'position:fixed','top:0','left:0','width:100%','height:100%',
          'background:rgba(0,0,0,0.55)','z-index:2147483647',
          'display:flex','align-items:center','justify-content:center'
        ].join(';');

        overlay.innerHTML = `
          <div style="background:#1a1a2e;color:#e0e0e0;padding:28px 32px;border-radius:12px;
                      font-family:sans-serif;font-size:14px;max-width:400px;text-align:center;
                      box-shadow:0 8px 40px rgba(0,0,0,0.6);border:1px solid #333;">
            <div style="font-size:26px;margin-bottom:10px;">🔐</div>
            <div style="font-weight:bold;color:#4CAF50;margin-bottom:10px;font-size:15px;">SSO Extension</div>
            <div style="margin-bottom:20px;line-height:1.6;">${message}</div>
            <button id="__sso_ok__" style="background:#4CAF50;color:#fff;border:none;padding:9px 28px;
                    border-radius:6px;cursor:pointer;font-size:14px;margin-right:10px;">Save</button>
            <button id="__sso_cancel__" style="background:#444;color:#ccc;border:none;padding:9px 24px;
                    border-radius:6px;cursor:pointer;font-size:14px;">Skip</button>
          </div>`;

        document.body.appendChild(overlay);
        document.getElementById('__sso_ok__').onclick = () => { overlay.remove(); resolve(true); };
        document.getElementById('__sso_cancel__').onclick = () => { overlay.remove(); resolve(false); };
      } catch(e) {
        Utils.log('Custom confirm failed, falling back to confirm():', e.message);
        resolve(window.confirm(message));
      }
    });
  },

  /**
   * Internal sync confirm using our custom overlay (blocks via a flag, best-effort).
   * For truly async callers, prefer askConsentAsync.
   */
  _syncConfirm: function(message) {
    // Attempt the real confirm first (works on localhost apps)
    try {
      // On external sites confirm() often returns true immediately (suppressed)
      // We detect suppression: real confirm blocks the thread, suppressed returns instantly
      const start = Date.now();
      const result = window.confirm(message);
      const elapsed = Date.now() - start;
      // If it returned in <50ms the browser likely suppressed it → treat as "need async"
      if (elapsed < 50) {
        Utils.log('window.confirm() appears suppressed — will show async dialog on page');
        // Schedule async dialog (cannot block synchronously, so auto-return true here
        // and the async dialog handles UX). Credentials are already in sessionStorage.
        Utils.askConsentAsync(message).then(ok => {
          if (!ok) {
            // User declined after the fact — clear any stored learning data
            sessionStorage.removeItem('sso_learning_credentials');
            Utils.log('User declined consent (async dialog)');
          }
        });
        return true; // optimistic: proceed, async dialog gives user chance to revoke
      }
      return result;
    } catch(e) {
      return window.confirm(message);
    }
  }
};
