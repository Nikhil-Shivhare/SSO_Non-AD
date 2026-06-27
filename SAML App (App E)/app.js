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

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — App E (SAML SP)</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/shared/theme.css">
  <script src="/shared/app-features.js" defer></script>
  <style>
    .saml-badge {
      display: inline-flex; align-items: center; gap: 8px;
      background: linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%);
      color: #fff; padding: 6px 14px; border-radius: 20px;
      font-size: 0.78rem; font-weight: 600; letter-spacing: 0.5px;
      margin-bottom: 20px;
    }
    .saml-badge::before { content: "🔐"; font-size: 1rem; }
    .saml-attrs { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .saml-attrs th {
      background: rgba(45, 106, 159, 0.15); padding: 10px 14px;
      text-align: left; font-size: 0.82rem; font-weight: 600;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .saml-attrs td { padding: 10px 14px; font-size: 0.9rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .saml-attrs tr:last-child td { border-bottom: none; }
    .saml-btn {
      display: inline-flex; align-items: center; gap: 10px;
      background: linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%);
      color: #fff; text-decoration: none; padding: 14px 28px;
      border-radius: 10px; font-weight: 600; font-size: 1rem;
      transition: opacity 0.2s, transform 0.15s; border: none; cursor: pointer;
    }
    .saml-btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .error-box {
      background: rgba(220,50,50,0.15); border: 1px solid rgba(220,50,50,0.4);
      border-radius: 8px; padding: 14px 18px; color: #ff6b6b;
      margin-bottom: 20px; font-size: 0.9rem;
    }
    .info-box {
      background: rgba(45,106,159,0.15); border: 1px solid rgba(45,106,159,0.4);
      border-radius: 8px; padding: 14px 18px; color: #7ec8e3;
      margin-bottom: 20px; font-size: 0.9rem;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function loginPage(error) {
  const errorHtml = error
    ? `<div class="error-box">⚠️ ${error}</div>`
    : '';
  return page('Login', `
  <h1>App-E &mdash; SAML Service Provider</h1>
  <div class="saml-badge">SAML 2.0 Federated SSO</div>
  ${errorHtml}
  <div class="info-box">
    This application delegates authentication to the Primary Identity Service (PID)
    using the SAML 2.0 standard. No local password is required.
  </div>
  <h2>Sign In</h2>
  <p>Click below to be redirected to the PID Identity Provider for authentication.</p>
  <a id="saml-login-btn" href="/saml/login" class="saml-btn">
    🔐 Login with PID SAML SSO
  </a>
  <p style="margin-top:28px; font-size:0.82rem; opacity:0.6;">
    You will be redirected to <code>http://localhost:4000/login</code> if you are not already authenticated.
  </p>
`);
}

function dashboardPage(user) {
  const loginTime = user.loginTime
    ? new Date(user.loginTime).toLocaleString()
    : 'N/A';
  return page('Dashboard', `
  <h1>App-E Dashboard</h1>
  <div class="saml-badge">Authenticated via SAML SSO</div>
  <div class="welcome">
    <strong>Welcome, ${user.username}!</strong>
    <p>You are logged in to App-E through the PID SAML Identity Provider.</p>
  </div>
  <div class="menu">
    <h2>SAML Assertion Details</h2>
    <table class="saml-attrs">
      <tr><th>Attribute</th><th>Value</th></tr>
      <tr><td>Username (NameID)</td><td><strong>${user.username}</strong></td></tr>
      <tr><td>Role</td><td>${user.role || 'N/A'}</td></tr>
      <tr><td>Email</td><td>${user.email || 'N/A'}</td></tr>
      <tr><td>Issuer (IdP)</td><td><code>${user.issuer || 'N/A'}</code></td></tr>
      <tr><td>Login Method</td><td>SAML 2.0 Bearer Assertion</td></tr>
      <tr><td>Session Established</td><td>${loginTime}</td></tr>
    </table>
    <br>
    <h3>Navigation</h3>
    <a href="/logout" style="color:#ff6b6b;">Logout from App-E</a>
    &nbsp;&nbsp;|&nbsp;&nbsp;
    <a href="http://localhost:4000/dashboard" target="_blank">Open PID Dashboard</a>
  </div>
`);
}

function errorPage(code, message, detail) {
  return page(`${code} Error`, `
  <h1>${code} — ${message}</h1>
  <div class="error-box">${detail}</div>
  <a href="/login">← Back to Login</a>
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
