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
  const SCHEMA_KEY = 'sso_login_schema';
  
  // Store current loginSchema for learning mode
  let currentLoginSchema = null;
  
  // ==========================================================================
  // SESSION STORAGE HELPERS (for learning mode persistence across navigation)
  // ==========================================================================
  
  function saveLearningCredentials(fields) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ fields, origin: currentOrigin }));
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
  
  function saveLoginSchema(schema) {
    if (schema) {
      sessionStorage.setItem(SCHEMA_KEY, JSON.stringify({ schema, origin: currentOrigin }));
    }
  }
  
  function getLoginSchema() {
    const data = sessionStorage.getItem(SCHEMA_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed.origin === currentOrigin) return parsed.schema;
    return null;
  }
  
  function clearLoginSchema() {
    sessionStorage.removeItem(SCHEMA_KEY);
  }
  
  // ==========================================================================
  // FORM DETECTION
  // ==========================================================================
  
  /**
   * Find login form on page.
   * Uses generic password-field detection so it works on ANY site,
   * regardless of username field name (username, email, handleOrEmail, etc.)
   * @returns {{ form, usernameInput, passwordInput } | null}
   */
  function findLoginForm() {
    // Any visible password field = login form
    const passwordInput = document.querySelector('input[type="password"]');
    if (!passwordInput) return null;

    const form = passwordInput.closest('form');

    // Try common username-like selectors in order of specificity
    const usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[name="handleOrEmail"]',
      'input[name="login"]',
      'input[name="user"]',
      'input[name="handle"]',
      'input[type="email"]',
      'input[type="text"]',  // Generic text input fallback
    ];

    let usernameInput = null;
    for (const sel of usernameSelectors) {
      // Prefer to search within the form, then whole document
      const el = (form && form.querySelector(sel)) || document.querySelector(sel);
      if (el && el !== passwordInput) {
        usernameInput = el;
        break;
      }
    }

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
   * Schema-driven form filling
   * Iterates over loginSchema and fills each field from credential fields
   * @param {object} loginSchema - { fieldName: { selector, type } }
   * @param {object} fields - { fieldName: value }
   */
  function fillLoginFormWithSchema(loginSchema, fields) {
    if (!loginSchema || !fields) {
      Utils.log('Cannot fill - missing schema or fields');
      return false;
    }
    
    let filledCount = 0;
    
    for (const [fieldName, fieldConfig] of Object.entries(loginSchema)) {
      const { selector, type } = fieldConfig;
      const value = fields[fieldName];
      
      if (!value) {
        Utils.log(`Skipping field ${fieldName} - no value`);
        continue;
      }
      
      const element = document.querySelector(selector);
      if (!element) {
        Utils.log(`Field ${fieldName} not found with selector: ${selector}`);
        continue;
      }
      
      // Set value
      element.value = value;
      
      // Dispatch appropriate event based on field type
      if (type === 'select') {
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      Utils.log(`Filled ${fieldName} (${type})`);
      filledCount++;
    }
    
    Utils.log(`Form filled: ${filledCount} fields`);
    return filledCount > 0;
  }
  
  /**
   * Legacy form filling (fallback when no schema)
   * @param {{ username, password } | { fields: { username, password } }} credentials
   */
  function fillLoginForm(credentials) {
    const formData = findLoginForm();
    if (!formData) {
      Utils.log('Cannot fill - no login form found');
      return false;
    }
    
    const { usernameInput, passwordInput } = formData;
    
    // Support both legacy format and new fields format
    const username = credentials.fields ? credentials.fields.username : credentials.username;
    const password = credentials.fields ? credentials.fields.password : credentials.password;
    
    // Fill username
    usernameInput.value = username;
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Fill password
    passwordInput.value = password;
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    Utils.log('Form filled (legacy mode)');
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
   * Captures ALL fields defined in loginSchema
   * Handles both navigating apps and stateless apps (that return HTML without navigation)
   * @param {object} loginSchema - Optional schema for capturing extra fields
   */
  function enterLearningMode(loginSchema) {
    Utils.log('Learning mode: watching for manual login');
    
    // Store schema for post-login processing
    currentLoginSchema = loginSchema || getLoginSchema();
    if (loginSchema) {
      saveLoginSchema(loginSchema);
    }
    
    // CASE 2: First-time login notification
    Utils.showNotification('First-Time Login', 'No saved credentials found. Please log in manually.');
    
    const formData = findLoginForm();
    if (!formData) return;
    
    const { form, usernameInput, passwordInput } = formData;

    // Helper: capture + save + start watching 
    function captureAndWatch() {
      const capturedFields = captureFormFields(currentLoginSchema);

      // Check: did schema-driven capture get at least a password field?
      // We intentionally DON'T check for 'username' because apps like Codeforces
      // use 'handleOrEmail', LeetCode uses 'login', etc.
      const schemaGotPassword = capturedFields && capturedFields.password;
      const schemaGotAnyField = capturedFields && Object.keys(capturedFields).length >= 2;

      if (schemaGotPassword && schemaGotAnyField) {
        // Schema-driven capture succeeded — save with schema field names intact
        // (e.g. { handleOrEmail: '...', password: '...' })
        // This ensures fillLoginFormWithSchema() can match them back via the schema keys
        saveLearningCredentials(capturedFields);
        Utils.log('Learning mode: captured fields via schema', Object.keys(capturedFields));
      } else {
        // Fallback: read directly from DOM inputs (covers no-schema case)
        const u = usernameInput ? usernameInput.value : '';
        const p = passwordInput ? passwordInput.value : '';
        if (u && p) {
          saveLearningCredentials({ username: u, password: p });
          Utils.log('Learning mode: captured via DOM fallback (username/password)');
        } else {
          Utils.log('Learning mode: no credentials captured — fields were empty at capture time');
          return;
        }
      }
      // Start watching for success (works for both SPAs and traditional apps)
      watchWithObserver();
    }

    // 1. Native form submit (traditional apps)
    if (form) {
      form.addEventListener('submit', () => {
        Utils.log('Learning mode: form submit fired');
        captureAndWatch();
      });
    }

    // 2. Submit button click (React/SPA fallback — captures BEFORE React clears fields)
    const submitBtn = form
      ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
      : document.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        Utils.log('Learning mode: submit button click fired');
        captureAndWatch();
      });
    }

    /**
     * Use MutationObserver to watch for the login form disappearing from the DOM.
     * This is the most reliable success signal for React/Vue/Angular SPAs.
     */
    function watchWithObserver() {
      Utils.log('Learning mode: MutationObserver watching for form removal...');
      let resolved = false;

      const observer = new MutationObserver(() => {
        if (resolved) return;
        const stillHasForm = !!document.querySelector('input[type="password"]');
        if (!stillHasForm) {
          resolved = true;
          observer.disconnect();
          Utils.log('Learning mode: password field gone — login appears successful (SPA)');
          handleLearningSuccess();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // Fallback timeout after 5 seconds — disconnect observer and check once
      setTimeout(() => {
        if (resolved) return;
        observer.disconnect();
        Utils.log('Learning mode: observer timeout — checking manually');
        watchForLoginSuccess();
      }, 5000);
    }

    /**
     * Called by observer when login form disappears.
     */
    function handleLearningSuccess() {
      const capturedData = getLearningCredentials();
      if (!capturedData) {
        Utils.log('Learning mode: observer fired but no credentials captured');
        return;
      }

      if (Utils.askConsent('Login successful. Save credentials for future automatic login?')) {
        chrome.runtime.sendMessage({
          action: 'saveCredentials',
          origin: currentOrigin,
          fields: capturedData.fields
        }, (response) => {
          if (response && response.success) {
            Utils.showNotification('Credentials Saved', 'SSO is now enabled for this application.');
            Utils.log('Credentials saved (SPA observer mode)');
          } else {
            Utils.log('Failed to save credentials:', response ? response.error : 'No response');
          }
        });
      }

      clearLearningCredentials();
      clearLoginSchema();
    }
  }
  
  /**
   * Watch for login success in stateless apps (no page navigation)
   * Checks if login form has disappeared after submission
   */
  function watchForLoginSuccess() {
    const capturedData = getLearningCredentials();
    if (!capturedData) return;
    
    // Check if login form is gone (means we're now on dashboard)
    const formData = findLoginForm();
    if (!formData) {
      Utils.log('Learning mode: login form disappeared - assuming success (stateless app)');
      
      // CASE 3: Ask user consent to save
      if (Utils.askConsent('Login successful. Save credentials for future automatic login?')) {
        chrome.runtime.sendMessage({
          action: 'saveCredentials',
          origin: currentOrigin,
          fields: capturedData.fields
        }, (response) => {
          if (response && response.success) {
            // CASE 4: Credentials saved notification
            Utils.showNotification('Credentials Saved', 'SSO is now enabled for this application.');
            Utils.log('Credentials saved (stateless app)');
          } else {
            Utils.log('Failed to save credentials:', response ? response.error : 'No response');
          }
        });
      }
      
      // Clear storage after handling
      clearLearningCredentials();
      clearLoginSchema();
    } else {
      // Form still present - login might have failed, clear stored credentials
      Utils.log('Learning mode: form still present - login may have failed');
      clearLearningCredentials();
      clearLoginSchema();
    }
  }
  
  /**
   * Capture all form fields based on schema
   * @param {object} loginSchema
   * @returns {object} fields
   */
  function captureFormFields(loginSchema) {
    const fields = {};
    
    if (loginSchema) {
      // Schema-driven capture
      for (const [fieldName, fieldConfig] of Object.entries(loginSchema)) {
        const element = document.querySelector(fieldConfig.selector);
        if (element && element.value) {
          fields[fieldName] = element.value;
        }
      }
    } else {
      // Fallback: capture username and password
      const formData = findLoginForm();
      if (formData) {
        fields.username = formData.usernameInput.value;
        fields.password = formData.passwordInput.value;
      }
    }
    
    return fields;
  }
  
  /**
   * Check if login was successful and save captured credentials
   */
  function checkLearningSuccess() {
    // Check if we have captured credentials from previous page
    const capturedData = getLearningCredentials();
    if (!capturedData) return;
    
    // Simple heuristic: if we're no longer on a login page, assume success
    const formData = findLoginForm();
    if (formData) {
      // Still on login page - not successful yet, clear stored credentials
      clearLearningCredentials();
      clearLoginSchema();
      return;
    }
    
    Utils.log('Learning mode: login appears successful');
    
    // CASE 3: Ask user consent
    if (Utils.askConsent('Login successful. Save credentials for future automatic login?')) {
      chrome.runtime.sendMessage({
        action: 'saveCredentials',
        origin: currentOrigin,
        fields: capturedData.fields
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
    clearLoginSchema();
    // Clear auto-login attempt flag (credentials updated, next attempt should try silently)
    sessionStorage.removeItem('sso_auto_login_attempted');
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
    
    form.addEventListener('submit', async (e) => {
      const newPwd = newPassword.value;
      if (newPwd) {
        savePasswordChangeData(newPwd);
        Utils.log('Password change: captured new password');
        
        // Wait for form submission and check for success message
        await Utils.sleep(1000); // Give server time to respond
        
        // Watch for success message appearing on the page
        watchForPasswordChangeSuccess(newPwd);
      }
    });
  }
  
  /**
   * Watch for password change success message and auto-update vault
   */
  function watchForPasswordChangeSuccess(newPassword) {
    Utils.log('Watching for password change success...');
    
    let checkCount = 0;
    const maxChecks = 10; // Check for 5 seconds total
    
    const checkInterval = setInterval(() => {
      checkCount++;
      
      // Check for success message
      const hasSuccess = checkForSuccessMessage();
      
      if (hasSuccess) {
        clearInterval(checkInterval);
        Utils.log('Password change success detected!');
        
        // Update vault automatically
        chrome.runtime.sendMessage({
          action: 'updatePassword',
          origin: currentOrigin,
          newPassword: newPassword
        }, (response) => {
          if (response && response.success) {
            Utils.showNotification('Password Updated', 'Your new password has been saved to the vault.');
            Utils.log('Password updated in vault');
          } else {
            Utils.log('Failed to update password:', response ? response.error : 'No response');
          }
        });
        
        clearPasswordChangeData();
      } else if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        Utils.log('Password change: no success message detected after timeout');
      }
    }, 500);
  }
  
  /**
   * Check if success message exists on page
   */
  function checkForSuccessMessage() {
    // Check common success class patterns
    const successElements = document.querySelectorAll('.success, .alert-success, .message-success');
    for (const el of successElements) {
      if (el.textContent && el.textContent.toLowerCase().includes('success')) {
        return true;
      }
    }
    
    // Also check for text content directly
    const bodyText = document.body.innerText.toLowerCase();
    if (bodyText.includes('password changed successfully') || 
        bodyText.includes('password updated successfully')) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Check if password change was successful (called after page navigation/reload)
   */
  function checkPasswordChangeSuccess() {
    const data = getPasswordChangeData();
    if (!data) return;
    
    // Check for success indicators on the page
    // Apps typically show a success message after password change
    const successIndicators = [
      '.success',
      '.alert-success', 
      '[class*="success"]',
      ':contains("Password changed")',
      ':contains("successfully")'
    ];
    
    // Check if page contains success message
    let hasSuccessMessage = false;
    
    // Check common success class patterns
    const successElements = document.querySelectorAll('.success, .alert-success, .message-success');
    for (const el of successElements) {
      if (el.textContent && el.textContent.toLowerCase().includes('success')) {
        hasSuccessMessage = true;
        break;
      }
    }
    
    // Also check for text content directly
    if (!hasSuccessMessage) {
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('password changed successfully') || 
          bodyText.includes('password updated successfully')) {
        hasSuccessMessage = true;
      }
    }
    
    if (hasSuccessMessage) {
      Utils.log('Password change: success message detected, updating vault');
      
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
      return;
    }
    
    // Check if we navigated away from password change page (alternative success indicator)
    if (!findPasswordChangeForm()) {
      Utils.log('Password change: navigated away, might be successful');
      
      if (Utils.askConsent('Password might have changed. Update saved credentials?')) {
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
      return;
    }
    
    // Still on password change form with no success message - might have failed
    // Keep the data in case user retries
    Utils.log('Password change: still on form with no success message, keeping data for retry');
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
    
    // Check for login form — may not be in DOM yet on React/SPA sites
    const loginForm = findLoginForm();
    if (!loginForm) {
      // Check if we were in learning mode and login succeeded
      checkLearningSuccess();

      // --- SPA FALLBACK: Watch for login form to appear dynamically ---
      // React/Angular/Vue sites render forms AFTER page load.
      // We observe DOM mutations and run the full flow once the form appears.
      Utils.log('No login form yet — watching for dynamic form insertion (SPA)...');
      let spaFormDetected = false;
      const spaObserver = new MutationObserver(() => {
        if (spaFormDetected) return;
        if (findLoginForm()) {
          spaFormDetected = true;
          spaObserver.disconnect();
          Utils.log('Login form appeared dynamically (SPA)');
          runLoginFlow();
        } else if (findPasswordChangeForm()) {
          spaFormDetected = true;
          spaObserver.disconnect();
          handlePasswordChange();
        }
      });
      spaObserver.observe(document.body, { childList: true, subtree: true });

      // Stop watching after 10 seconds to avoid memory leaks
      setTimeout(() => {
        if (!spaFormDetected) {
          spaObserver.disconnect();
        }
      }, 10000);
      return;
    }
    
    Utils.log('Login form detected');
    runLoginFlow();
  }

  async function runLoginFlow() {
    
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
          enterLearningMode(response.loginSchema);
        } else {
          Utils.log('Cannot proceed:', response.error);
        }
        return;
      }
      
      // Check if we already tried auto-login and it failed
      const autoLoginAttempted = sessionStorage.getItem('sso_auto_login_attempted');
      
      if (autoLoginAttempted === currentOrigin) {
        // We already tried auto-login and we're back on login page = login failed
        sessionStorage.removeItem('sso_auto_login_attempted');
        
        Utils.log('Auto-login failed - showing options to user');
        
        const action = prompt(
          'SSO: Auto-login failed (credentials may be incorrect).\n\n' +
          'Options:\n' +
          '1 = Retry auto-login (use saved credentials)\n' +
          '2 = Type manually (skip SSO this time)\n' +
          '3 = Update credentials (login manually and save new)\n\n' +
          'Enter 1, 2, or 3:',
          '1'
        );
        
        if (action === '2') {
          Utils.log('User chose to type manually');
          Utils.showNotification('SSO Skipped', 'You can now enter credentials manually.');
          return;
        }
        
        if (action === '3') {
          Utils.log('User chose to update credentials');
          Utils.showNotification('Update Mode', 'Please enter your new credentials. They will be saved after successful login.');
          enterLearningMode(response.loginSchema);
          return;
        }
        
        // action === '1' - retry auto-login (fall through)
      }
      
      // SILENT AUTO-LOGIN: Try to login without prompting
      Utils.log('Credentials found - attempting silent auto-login');
      
      // Mark that we're attempting auto-login (to detect failure on next page load)
      sessionStorage.setItem('sso_auto_login_attempted', currentOrigin);
      
      await Utils.sleep(300);
      
      // Use schema-driven filling if available, otherwise fallback
      let filled = false;
      if (response.loginSchema && response.credentials.fields) {
        filled = fillLoginFormWithSchema(response.loginSchema, response.credentials.fields);
      } else {
        filled = fillLoginForm(response.credentials);
      }
      
      if (filled) {
        await Utils.sleep(500);
        submitLoginForm();
        
        // If login succeeds, the page will navigate away
        // If we're still here after a delay, login might have failed (but page didn't reload)
        await Utils.sleep(2000);
        
        // Check if we're still on login page (error shown inline)
        if (findLoginForm()) {
          // Login failed without page reload - show options immediately
          sessionStorage.removeItem('sso_auto_login_attempted');
          Utils.log('Auto-login failed (still on login page) - showing options');
          
          const action = prompt(
            'SSO: Auto-login failed (credentials may be incorrect).\n\n' +
            'Options:\n' +
            '1 = Retry auto-login\n' +
            '2 = Type manually (skip SSO)\n' +
            '3 = Update credentials\n\n' +
            'Enter 1, 2, or 3:',
            '1'
          );
          
          if (action === '2') {
            Utils.showNotification('SSO Skipped', 'You can now enter credentials manually.');
            return;
          }
          
          if (action === '3') {
            Utils.showNotification('Update Mode', 'Please enter new credentials.');
            enterLearningMode(response.loginSchema);
            return;
          }
          
          // Retry = do nothing, user can reload page
        }
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
