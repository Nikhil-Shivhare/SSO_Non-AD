/**
 * content.js - SSO Extension Content Script
 * 
 * Handles DOM interaction:
 * - Detect login forms
 * - Fill credentials
 * - Submit forms
 * - Detect login success
 * - Detect password change pages
 * - Notify background of events
 * 
 * NEVER calls Primary Identity APIs directly.
 * NEVER stores credentials.
 * NEVER makes trust decisions.
 */

(function() {
  'use strict';
  
  const currentOrigin = window.location.origin;
  const STORAGE_KEY = 'sso_learning_credentials';
  
  // ==========================================================================
  // SESSION STORAGE HELPERS (for learning mode persistence across navigation)
  // ==========================================================================
  
  function saveLearningCredentials(username, password) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ username, password, origin: currentOrigin }));
  }
  
  function getLearningCredentials() {
    const data = sessionStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    // Only return if same origin
    if (parsed.origin === currentOrigin) return parsed;
    return null;
  }
  
  function clearLearningCredentials() {
    sessionStorage.removeItem(STORAGE_KEY);
  }
  
  // ==========================================================================
  // FORM DETECTION
  // ==========================================================================
  
  /**
   * Find login form on page
   * @returns {{ form, usernameInput, passwordInput } | null}
   */
  function findLoginForm() {
    const usernameInput = document.querySelector('input[name="username"]');
    const passwordInput = document.querySelector('input[name="password"]');
    
    if (!usernameInput || !passwordInput) {
      return null;
    }
    
    const form = usernameInput.closest('form') || passwordInput.closest('form');
    
    return { form, usernameInput, passwordInput };
  }
  
  /**
   * Find password change form on page
   * Detects form with current_password and new_password fields
   * confirm_password is optional (not all apps have it)
   * @returns {{ form, currentPassword, newPassword, confirmPassword } | null}
   */
  function findPasswordChangeForm() {
    const currentPassword = document.querySelector('input[name="current_password"]');
    const newPassword = document.querySelector('input[name="new_password"]');
    const confirmPassword = document.querySelector('input[name="confirm_password"]'); // Optional
    
    // Only require current and new password
    if (!currentPassword || !newPassword) {
      return null;
    }
    
    const form = currentPassword.closest('form') || newPassword.closest('form');
    
    return { form, currentPassword, newPassword, confirmPassword };
  }
  
  // ==========================================================================
  // FORM ACTIONS
  // ==========================================================================
  
  /**
   * Fill login form with credentials
   * @param {{ username, password }} credentials
   */
  function fillLoginForm(credentials) {
    const formData = findLoginForm();
    if (!formData) {
      Utils.log('Cannot fill - no login form found');
      return false;
    }
    
    const { usernameInput, passwordInput } = formData;
    
    // Fill username
    usernameInput.value = credentials.username;
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Fill password
    passwordInput.value = credentials.password;
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    Utils.log('Form filled');
    return true;
  }
  
  /**
   * Submit the login form
   */
  function submitLoginForm() {
    const formData = findLoginForm();
    if (!formData || !formData.form) {
      Utils.log('Cannot submit - no form found');
      return;
    }
    
    // Try submit button first
    const submitBtn = formData.form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      Utils.log('Clicking submit button');
      submitBtn.click();
      return;
    }
    
    // Fallback to form.submit()
    Utils.log('Calling form.submit()');
    formData.form.submit();
  }
  
  // ==========================================================================
  // LEARNING MODE
  // ==========================================================================
  
  /**
   * Enter learning mode - watch for manual login
   */
  function enterLearningMode() {
    Utils.log('Learning mode: watching for manual login');
    
    // CASE 2: First-time login notification
    Utils.showNotification('First-Time Login', 'No saved credentials found. Please log in manually.');
    
    const formData = findLoginForm();
    if (!formData) return;
    
    const { form, usernameInput, passwordInput } = formData;
    
    // Capture credentials before form submission and save to sessionStorage
    if (form) {
      form.addEventListener('submit', () => {
        const username = usernameInput.value;
        const password = passwordInput.value;
        if (username && password) {
          saveLearningCredentials(username, password);
          Utils.log('Learning mode: captured credentials for', username);
        }
      });
    }
  }
  
  /**
   * Check if login was successful and save captured credentials
   */
  function checkLearningSuccess() {
    // Check if we have captured credentials from previous page
    const capturedCredentials = getLearningCredentials();
    if (!capturedCredentials) return;
    
    // Simple heuristic: if we're no longer on a login page, assume success
    const formData = findLoginForm();
    if (formData) {
      // Still on login page - not successful yet, clear stored credentials
      clearLearningCredentials();
      return;
    }
    
    Utils.log('Learning mode: login appears successful');
    
    // CASE 3: Ask user consent
    if (Utils.askConsent('Login successful. Save credentials for future automatic login?')) {
      chrome.runtime.sendMessage({
        action: 'saveCredentials',
        origin: currentOrigin,
        username: capturedCredentials.username,
        password: capturedCredentials.password
      }, (response) => {
        if (response && response.success) {
          // CASE 4: Credentials saved notification
          Utils.showNotification('Credentials Saved', 'SSO is now enabled for this application.');
          Utils.log('Credentials saved');
        } else {
          Utils.log('Failed to save credentials:', response ? response.error : 'No response');
        }
      });
    }
    
    // Clear storage after handling
    clearLearningCredentials();
  }
  
  // ==========================================================================
  // PASSWORD CHANGE HANDLING
  // ==========================================================================
  
  const PWD_CHANGE_KEY = 'sso_password_change';
  
  /**
   * Save password change data to sessionStorage
   */
  function savePasswordChangeData(newPassword) {
    sessionStorage.setItem(PWD_CHANGE_KEY, JSON.stringify({ 
      newPassword, 
      origin: currentOrigin 
    }));
  }
  
  /**
   * Get password change data from sessionStorage
   */
  function getPasswordChangeData() {
    const data = sessionStorage.getItem(PWD_CHANGE_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed.origin === currentOrigin) return parsed;
    return null;
  }
  
  /**
   * Clear password change data
   */
  function clearPasswordChangeData() {
    sessionStorage.removeItem(PWD_CHANGE_KEY);
  }
  
  /**
   * Handle password change form - capture new password on submit
   */
  function handlePasswordChange() {
    const formData = findPasswordChangeForm();
    if (!formData) return;
    
    Utils.log('Password change form detected');
    Utils.showNotification('Password Change Detected', 'Your new password will be saved after successful change.');
    
    const { form, newPassword } = formData;
    
    form.addEventListener('submit', () => {
      const newPwd = newPassword.value;
      if (newPwd) {
        savePasswordChangeData(newPwd);
        Utils.log('Password change: captured new password');
      }
    });
  }
  
  /**
   * Check if password change was successful (called after page navigation)
   */
  function checkPasswordChangeSuccess() {
    const data = getPasswordChangeData();
    if (!data) return;
    
    // If we're still on a password change page, the change might have failed
    if (findPasswordChangeForm()) {
      Utils.log('Password change: still on change page, might have failed');
      clearPasswordChangeData();
      return;
    }
    
    Utils.log('Password change: appears successful, updating vault');
    
    // Ask user confirmation before updating
    if (Utils.askConsent('Password change successful. Update saved credentials with new password?')) {
      chrome.runtime.sendMessage({
        action: 'updatePassword',
        origin: currentOrigin,
        newPassword: data.newPassword
      }, (response) => {
        if (response && response.success) {
          Utils.showNotification('Password Updated', 'Your new password has been saved to the vault.');
          Utils.log('Password updated in vault');
        } else {
          Utils.log('Failed to update password:', response ? response.error : 'No response');
        }
      });
    }
    
    clearPasswordChangeData();
  }
  
  // ==========================================================================
  // MAIN FLOW
  // ==========================================================================
  
  async function main() {
    Utils.log('Content script loaded on', currentOrigin);
    
    // Check for pending password change success (after navigation)
    checkPasswordChangeSuccess();
    
    // Check for password change form first
    if (findPasswordChangeForm()) {
      handlePasswordChange();
      return;
    }
    
    // Check for login form
    const loginForm = findLoginForm();
    if (!loginForm) {
      // Check if we were in learning mode and login succeeded
      checkLearningSuccess();
      return;
    }
    
    Utils.log('Login form detected');
    
    // Request credentials from background
    chrome.runtime.sendMessage({
      action: 'getCredentials',
      origin: currentOrigin
    }, async (response) => {
      if (chrome.runtime.lastError) {
        Utils.log('Error:', chrome.runtime.lastError.message);
        return;
      }
      
      if (!response) {
        Utils.log('No response from background');
        return;
      }
      
      if (!response.success) {
        if (response.needsLearning) {
          Utils.log('No credentials stored - entering learning mode');
          enterLearningMode();
        } else {
          Utils.log('Cannot proceed:', response.error);
        }
        return;
      }
      
      // CASE 1: Credentials found - ask user what to do
      const action = prompt(
        'SSO: Saved credentials found for this site.\n\n' +
        'Options:\n' +
        '1 = Auto-login (use saved credentials)\n' +
        '2 = Type manually (skip SSO this time)\n' +
        '3 = Update credentials (login manually and save new)\n\n' +
        'Enter 1, 2, or 3:',
        '1'
      );
      
      if (action === '2') {
        // User wants to type manually - do nothing
        Utils.log('User chose to type manually');
        Utils.showNotification('SSO Skipped', 'You can now enter credentials manually.');
        return;
      }
      
      if (action === '3') {
        // User wants to update credentials - enter learning mode
        Utils.log('User chose to update credentials');
        Utils.showNotification('Update Mode', 'Please enter your new credentials. They will be saved after successful login.');
        enterLearningMode();
        return;
      }
      
      // Default (action === '1' or anything else) - auto-login
      Utils.showNotification('SSO Active', 'Logging you in automatically...');
      Utils.log('Received credentials, filling form');
      
      await Utils.sleep(500);
      
      const filled = fillLoginForm(response.credentials);
      if (filled) {
        await Utils.sleep(500);
        submitLoginForm();
      }
    });
  }
  
  // Run main
  main();
  
})();

// Deferred to future hardening phase:
// - Retry logic on form fill failure
// - Better login success detection
// - MFA handling
// - Role selection
