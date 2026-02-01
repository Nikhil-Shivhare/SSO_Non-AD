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
    
    const { form } = formData;
    
    // Capture credentials before form submission
    if (form) {
      form.addEventListener('submit', () => {
        const capturedFields = captureFormFields(currentLoginSchema);
        if (capturedFields && capturedFields.username && capturedFields.password) {
          saveLearningCredentials(capturedFields);
          Utils.log('Learning mode: captured fields', Object.keys(capturedFields));
        }
      });
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
          enterLearningMode(response.loginSchema);
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
        enterLearningMode(response.loginSchema);
        return;
      }
      
      // Default (action === '1' or anything else) - auto-login
      Utils.showNotification('SSO Active', 'Logging you in automatically...');
      Utils.log('Received credentials, filling form');
      
      await Utils.sleep(500);
      
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
