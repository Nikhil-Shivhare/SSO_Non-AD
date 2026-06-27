/**
 * SAML App E — Service Provider (SP)
 *
 * Implements full SP-initiated SAML SSO using @node-saml/node-saml.
 *
 * Routes:
 *   GET  /                  → redirect to /login or /dashboard
 *   GET  /login             → show "Login with PID SAML SSO" button
 *   GET  /saml/login        → generate AuthnRequest and redirect to PID
 *   POST /saml/acs          → receive SAMLResponse, verify, create session
 *   GET  /saml/metadata     → SP metadata XML
 *   GET  /dashboard         → protected; shows SAML assertion details
 *   GET  /logout            → destroy App E session only
 *
 * Security notes (MVP / PoC):
 *   - validateInResponseTo: "always" is mandatory (default is "never")
 *   - /saml/acs is deliberately excluded from CSRF middleware
 *   - PID public certificate loaded from PID/certs/dev-idp.crt
 */

'use strict';

const express  = require('express');
const session  = require('express-session');
const { SAML } = require('@node-saml/node-saml');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = parseInt(process.env.APP_E_PORT || '3005', 10);

// ---------------------------------------------------------------------------
// Load PID public certificate (used to verify SAML response signatures)
// ---------------------------------------------------------------------------

const PID_CERT_PATH = path.resolve(
  __dirname,
  '..',
  'PID',
  'certs',
  'dev-idp.crt'
);

let idpCert;
try {
  const raw = fs.readFileSync(PID_CERT_PATH, 'utf8');
  // node-saml expects just the base64 body (no PEM headers)
  idpCert = raw
    .split('\n')
    .filter(l => l && !l.startsWith('-----'))
    .join('');
} catch (err) {
  console.error('[App-E] FATAL: Cannot load PID certificate from', PID_CERT_PATH);
  console.error('[App-E]', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SAML SP configuration
// ---------------------------------------------------------------------------

const saml = new SAML({
  // IdP settings
  entryPoint:  process.env.SAML_IDP_SSO_URL  || 'http://localhost:4000/saml/sso',
  idpIssuer:   process.env.SAML_IDP_ENTITY_ID || 'http://localhost:4000/saml/metadata',
  idpCert,

  // SP settings
  issuer:      process.env.APP_E_ENTITY_ID   || 'http://localhost:3005/saml/metadata',
  callbackUrl: process.env.APP_E_ACS_URL     || 'http://localhost:3005/saml/acs',

  // Security
  validateInResponseTo:          'always',   // MANDATORY — default is "never"
  requestIdExpirationPeriodMs:   5 * 60 * 1000,   // 5 minutes
  acceptedClockSkewMs:           2 * 60 * 1000,   // 2 minutes

  // Signing: PID IdP signs the Assertion element (not the Response envelope)
  // wantAuthnResponseSigned must be false so node-saml falls through to
  // assertion-level signature verification instead of throwing on the Response
  wantAuthnResponseSigned: false,
  wantAssertionsSigned:    true,

  // We do not sign AuthnRequests in this MVP
  authnRequestBinding: 'HTTP-Redirect',
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/shared', express.static(path.join(__dirname, '..', 'shared-ui')));

app.use(session({
  secret:           process.env.APP_E_SESSION_SECRET || 'app-e-saml-demo-secret-change-me',
  resave:           false,
  saveUninitialized: false,
  cookie: {
    maxAge:   30 * 60 * 1000,  // 30 minutes
    httpOnly: true,
  },
}));

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App identity — acts as a simple internal document portal for demo purposes
// ---------------------------------------------------------------------------
const APP_NAME    = 'AccopsPortal';
const APP_TAGLINE = 'Internal Document & Resource Portal';

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${APP_NAME}</title>
  <meta name="description" content="${APP_NAME} — ${APP_TAGLINE}">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/shared/theme.css">
  <script src="/shared/app-features.js" defer></script>
  <style>
    /* ── SSO / identity badge ── */
    .sso-badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: linear-gradient(135deg, #0f2d52 0%, #1a5276 100%);
      color: #a8d8f0; padding: 5px 13px; border-radius: 20px;
      font-size: 0.74rem; font-weight: 600; letter-spacing: 0.6px;
      text-transform: uppercase; margin-bottom: 22px;
    }
    .sso-badge::before { content: '🔒'; }

    /* ── App header bar (login page) ── */
    .app-header {
      text-align: center; margin-bottom: 8px;
    }
    .app-header .app-icon {
      font-size: 2.4rem; display: block; margin-bottom: 6px;
    }
    .app-header h1 { font-size: 1.7rem; margin-bottom: 4px; }
    .app-header .tagline {
      font-size: 0.82rem; color: #636e72; margin-top: 0;
    }

    /* ── Login card ── */
    .login-card {
      background: rgba(255,255,255,0.72);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,0.85);
      border-radius: 16px;
      padding: 38px 40px 32px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.09);
      width: 100%; max-width: 420px;
      margin: 12px auto;
      text-align: center;
    }
    .login-card .divider {
      border: none; border-top: 1px solid rgba(0,0,0,0.08);
      margin: 22px 0;
    }
    .login-card .hint {
      font-size: 0.78rem; color: #b2bec3; margin-top: 18px; line-height: 1.5;
    }

    /* ── Primary SSO button ── */
    .btn-sso {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%;
      background: linear-gradient(135deg, #1a5276 0%, #2980b9 100%);
      color: #fff; text-decoration: none;
      padding: 14px 20px; border-radius: 10px;
      font-weight: 600; font-size: 0.97rem;
      transition: opacity 0.18s, transform 0.15s, box-shadow 0.18s;
      box-shadow: 0 4px 14px rgba(26,82,118,0.28);
      border: none; cursor: pointer;
    }
    .btn-sso:hover {
      opacity: 0.9; transform: translateY(-2px);
      box-shadow: 0 7px 20px rgba(26,82,118,0.35);
      text-decoration: none; color: #fff;
    }
    .btn-sso .icon { font-size: 1.15rem; }

    /* ── Profile header (dashboard) ── */
    .profile-card {
      background: linear-gradient(135deg, #0f2d52 0%, #1a5276 100%);
      border-radius: 14px 14px 0 0;
      padding: 26px 28px 22px;
      color: #fff;
      display: flex; align-items: center; gap: 16px;
    }
    .profile-card .avatar {
      width: 52px; height: 52px; border-radius: 50%;
      background: rgba(255,255,255,0.18);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.5rem; flex-shrink: 0;
    }
    .profile-card .info h2 {
      color: #fff; font-size: 1.15rem; margin: 0 0 3px;
      text-align: left;
    }
    .profile-card .info .sub {
      font-size: 0.8rem; color: rgba(255,255,255,0.65);
      text-align: left; margin: 0;
    }
    .profile-card .role-pill {
      margin-left: auto; flex-shrink: 0;
      background: rgba(255,255,255,0.18);
      color: #a8d8f0; padding: 4px 11px; border-radius: 12px;
      font-size: 0.75rem; font-weight: 600; text-transform: capitalize;
    }

    /* ── Dashboard body panels ── */
    .dash-body {
      background: rgba(255,255,255,0.72);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,0.85);
      border-top: none;
      border-radius: 0 0 14px 14px;
      padding: 24px 28px 28px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.09);
      width: 100%; max-width: 480px;
    }
    .dash-wrapper {
      width: 100%; max-width: 480px; margin: 20px auto;
    }

    /* ── Quick-action links ── */
    .quick-actions { margin: 8px 0 20px; }
    .quick-actions a {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; border-radius: 9px;
      background: rgba(255,255,255,0.7);
      border: 1px solid rgba(0,0,0,0.06);
      color: #2d3436; text-decoration: none;
      font-size: 0.9rem; font-weight: 500;
      margin-bottom: 8px;
      transition: all 0.18s;
    }
    .quick-actions a:hover {
      background: #fff; border-color: rgba(0,0,0,0.1);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.06);
      text-decoration: none;
    }
    .quick-actions a .qa-icon { font-size: 1.1rem; }
    .quick-actions a.danger { color: #c0392b; }
    .quick-actions a.danger:hover { border-color: rgba(192,57,43,0.25); }

    /* ── Identity details table ── */
    .id-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    .id-table tr:not(:last-child) td { border-bottom: 1px solid rgba(0,0,0,0.06); }
    .id-table td { padding: 9px 4px; font-size: 0.85rem; }
    .id-table td:first-child { color: #636e72; width: 42%; }
    .id-table td:last-child { color: #2d3436; font-weight: 500; word-break: break-all; }
    .id-table code { font-size: 0.78rem; color: #6c5ce7; background: rgba(108,92,231,0.08); padding: 2px 6px; border-radius: 4px; }

    /* ── Section label ── */
    .section-label {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: #b2bec3; margin: 18px 0 10px;
    }

    /* ── Error page ── */
    .err-card {
      background: rgba(255,255,255,0.72);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,0.85);
      border-radius: 16px; padding: 40px;
      text-align: center; max-width: 420px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.09);
    }
    .err-icon { font-size: 2.8rem; margin-bottom: 14px; }
    .err-msg {
      background: rgba(220,50,50,0.1); border: 1px solid rgba(220,50,50,0.25);
      border-radius: 8px; padding: 12px 16px;
      color: #c0392b; font-size: 0.88rem; margin: 18px 0 22px;
      text-align: left; line-height: 1.5;
    }
    .btn-back {
      display: inline-block; padding: 11px 24px;
      background: linear-gradient(135deg, #6c5ce7 0%, #a29bfe 100%);
      color: #fff; border-radius: 9px; font-weight: 600;
      text-decoration: none; font-size: 0.93rem;
      transition: opacity 0.18s, transform 0.15s;
    }
    .btn-back:hover { opacity: 0.88; transform: translateY(-1px); text-decoration: none; color: #fff; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function loginPage(error) {
  const errHtml = error
    ? `<p class="hint" style="color:#c0392b; margin-top:14px;">⚠ ${error}</p>`
    : '';
  return page('Sign In', `
  <div class="app-header">
    <span class="app-icon">📂</span>
    <h1>${APP_NAME}</h1>
    <p class="tagline">${APP_TAGLINE}</p>
  </div>
  <div class="login-card">
    <div class="sso-badge">SAML 2.0 Federated SSO</div>
    <p style="font-size:0.88rem; color:#636e72; margin-bottom:18px;">
      Sign in with your organisation identity. No separate password needed for this app.
    </p>
    <a id="saml-login-btn" href="/saml/login" class="btn-sso">
      <span class="icon">🔑</span>
      Continue with PID Single Sign-On
    </a>
    ${errHtml}
    <hr class="divider">
    <p class="hint">
      Powered by <strong>PID Identity Provider</strong> · SAML 2.0 Bearer Assertion<br>
      Your credentials are managed centrally — this portal does not store passwords.
    </p>
  </div>
`);
}

function dashboardPage(user) {
  const loginTime = user.loginTime
    ? new Date(user.loginTime).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : 'N/A';
  const initials = (user.username || '?')[0].toUpperCase();
  const emailDisplay = user.email || `${user.username}@example.local`;

  return page('Dashboard', `
  <div class="dash-wrapper">
    <div class="profile-card">
      <div class="avatar">${initials}</div>
      <div class="info">
        <h2>${user.username}</h2>
        <p class="sub">${emailDisplay}</p>
      </div>
      <span class="role-pill">${user.role || 'user'}</span>
    </div>
    <div class="dash-body">

      <p class="section-label">Quick Actions</p>
      <div class="quick-actions">
        <a href="#" id="docs-link">
          <span class="qa-icon">📄</span> My Documents
          <span style="margin-left:auto; font-size:0.75rem; color:#b2bec3;">Demo</span>
        </a>
        <a href="#" id="team-link">
          <span class="qa-icon">👥</span> Team Directory
          <span style="margin-left:auto; font-size:0.75rem; color:#b2bec3;">Demo</span>
        </a>
        <a href="http://localhost:4000/dashboard" target="_blank" id="pid-link">
          <span class="qa-icon">🏛</span> Open PID Identity Centre
          <span style="margin-left:auto; font-size:0.75rem; color:#b2bec3;">↗</span>
        </a>
        <a href="/logout" class="danger" id="logout-link">
          <span class="qa-icon">🚪</span> Sign out of ${APP_NAME}
        </a>
      </div>

      <p class="section-label">Active Identity</p>
      <table class="id-table">
        <tr><td>Signed in as</td><td><strong>${user.username}</strong></td></tr>
        <tr><td>Email</td><td>${emailDisplay}</td></tr>
        <tr><td>Role</td><td>${user.role || 'user'}</td></tr>
        <tr><td>Identity Provider</td><td><code>${user.issuer || 'http://localhost:4000/saml/metadata'}</code></td></tr>
        <tr><td>Auth method</td><td>SAML 2.0 Bearer Assertion</td></tr>
        <tr><td>Session started</td><td>${loginTime}</td></tr>
      </table>

    </div>
  </div>
`);
}

function errorPage(code, message, detail) {
  return page(`${code} — Error`, `
  <div class="err-card">
    <div class="err-icon">${code >= 500 ? '⚙️' : '🔒'}</div>
    <h1 style="font-size:1.4rem; margin-bottom:6px;">${message}</h1>
    <p style="color:#636e72; font-size:0.88rem; margin-bottom:0;">Something went wrong during sign-in.</p>
    <div class="err-msg">${detail}</div>
    <a href="/login" class="btn-back">← Back to Sign In</a>
  </div>
`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET / — redirect
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

// GET /login — show login page with SAML button
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  const error = req.query.error || null;
  return res.send(loginPage(error));
});

// GET /saml/login — generate AuthnRequest and redirect to PID IdP
app.get('/saml/login', async (req, res) => {
  try {
    // node-saml v5: getAuthorizeUrlAsync returns a plain string URL
    const redirectUrl = await saml.getAuthorizeUrlAsync(
      '',    // RelayState (empty for MVP)
      undefined,
      {}
    );
    console.log('[App-E] Redirecting to PID SAML SSO:', redirectUrl.substring(0, 80) + '...');
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('[App-E] Error generating AuthnRequest:', err);
    return res.status(500).send(
      errorPage(500, 'AuthnRequest Error', `Failed to generate SAML login request: ${err.message}`)
    );
  }
});

// POST /saml/acs — receive and verify SAMLResponse from PID
// IMPORTANT: deliberately not protected by CSRF middleware.
// The cross-origin auto-POST from PID is validated entirely through
// SAML signature, issuer, audience, recipient, expiry, and InResponseTo checks.
app.post('/saml/acs', async (req, res) => {
  try {
    const { profile, loggedOut } = await saml.validatePostResponseAsync(req.body);

    if (loggedOut) {
      req.session.destroy(() => {});
      return res.redirect('/login');
    }

    if (!profile) {
      return res.status(401).send(
        errorPage(401, 'Authentication Failed', 'No user profile returned from SAML assertion.')
      );
    }

    console.log('[App-E] SAML validation SUCCESS — user:', profile.nameID);

    // Create App E session
    req.session.user = {
      username:  profile.nameID,
      role:      profile['role']     || profile.attributes?.role      || 'user',
      email:     profile['email']    || profile.attributes?.email     || `${profile.nameID}@example.local`,
      issuer:    profile.issuer      || 'http://localhost:4000/saml/metadata',
      loginTime: Date.now(),
    };

    // Immediately remove the stored request ID (saml library handles this internally
    // via its cache provider when validateInResponseTo is "always")
    return res.redirect('/dashboard');

  } catch (err) {
    console.error('[App-E] SAML ACS validation error:', err.message);

    // Provide a diagnostic message without leaking internals
    let reason = 'SAML response validation failed.';
    if (err.message.includes('expired'))          reason = 'SAML assertion has expired.';
    else if (err.message.includes('audience'))    reason = 'Audience restriction check failed.';
    else if (err.message.includes('signature'))   reason = 'Signature verification failed.';
    else if (err.message.includes('InResponseTo'))reason = 'InResponseTo mismatch — possible replay attack.';

    return res.status(401).send(
      errorPage(401, 'Authentication Failed', `${reason} <br><small>(${err.message})</small>`)
    );
  }
});

// GET /saml/metadata — SP metadata XML
app.get('/saml/metadata', (req, res) => {
  try {
    const metadata = saml.generateServiceProviderMetadata(null, null);
    res.set('Content-Type', 'application/xml');
    return res.send(metadata);
  } catch (err) {
    console.error('[App-E] Metadata generation error:', err);
    return res.status(500).send('Failed to generate SP metadata');
  }
});

// GET /dashboard — protected, shows SAML assertion details
app.get('/dashboard', requireAuth, (req, res) => {
  return res.send(dashboardPage(req.session.user));
});

// GET /logout — destroy App E session only (MVP: no global SAML SLO)
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[App-E] Session destruction error:', err);
    res.redirect('/login');
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[App-E] SAML Service Provider running at http://localhost:${PORT}`);
  console.log(`[App-E] SP Entity ID : http://localhost:${PORT}/saml/metadata`);
  console.log(`[App-E] ACS URL      : http://localhost:${PORT}/saml/acs`);
  console.log(`[App-E] IdP SSO URL  : http://localhost:4000/saml/sso`);
  console.log(`[App-E] IdP cert     : ${PID_CERT_PATH}`);
});
