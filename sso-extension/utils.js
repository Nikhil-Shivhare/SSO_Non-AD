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
   * Show notification to user
   * Uses browser notifications API with fallback to alert
   * @param {string} title
   * @param {string} message
   */
  showNotification: function(title, message) {
    // Try browser notifications first
    const notify = (typeof browser !== 'undefined' && browser.notifications) || 
                   (typeof chrome !== 'undefined' && chrome.notifications);
    
    if (notify && notify.create) {
      notify.create({
        type: 'basic',
        iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="%234CAF50"/></svg>',
        title: title,
        message: message
      });
    } else {
      // Fallback to alert
      alert(`${title}\n\n${message}`);
    }
    
    Utils.log(`[Notification] ${title}: ${message}`);
  },

  /**
   * Ask user for consent
   * Uses window.confirm
   * @param {string} message
   * @returns {boolean}
   */
  askConsent: function(message) {
    return window.confirm(message);
  }
};
