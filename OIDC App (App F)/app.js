/**
 * App F — OIDC Relying Party (Authorization Code flow, HS256)
 * Port: 3006
 *
 * Uses openid-client v4 (pinned — v5 is a breaking ES module rewrite).
 * PID (http://localhost:4000) acts as the OpenID Provider.
 *
 * CRITICAL NOTES:
 *   - token_endpoint_auth_method must be "client_secret_post" to match PID /token expectations.
 *     Default is client_secret_basic (HTTP header), which PID rejects.
 *   - id_token_signed_response_alg must be "HS256" — PID signs tokens with client_secret as HMAC key.
 *   - jwks_uri is intentionally omitted — openid-client cannot load symmetric keys from a JWKS URL.
 *   - state and nonce MUST be saved to session before redirecting to PID and read back in /callback.
 *     openid-client v4 generates them but does NOT persist them.
 *   - express-session cookie must have secure:false for HTTP localhost.
 *     secure:true silently drops the cookie on non-HTTPS, breaking state/nonce persistence.
 */

"use strict";

const express = require("express");
const session = require("express-session");
const { Issuer, generators } = require("openid-client"); // v4 API — requires openid-client@4

const app  = express();
const PORT = parseInt(process.env.APP_F_PORT || "3006", 10);

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------
const CLIENT_ID        = process.env.OIDC_CLIENT_ID     || "app_f";
const CLIENT_SECRET    = process.env.OIDC_CLIENT_SECRET || "app_f_secret_development_only";
const REDIRECT_URI     = process.env.APP_F_REDIRECT_URI || "http://localhost:3006/callback";
const PID_ISSUER       = process.env.PID_ISSUER_URL     || "http://localhost:4000";

// --------------------------------------------------------------------------
// Express session
// CRITICAL: secure must be false for HTTP localhost.
//           secure:true silently drops the cookie and state/nonce will be lost
//           after the round-trip to PID, causing "checks.state argument is missing".
// --------------------------------------------------------------------------
app.use(session({
  secret: process.env.APP_F_SESSION_SECRET || "app-f-oidc-dev-secret-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,           // MUST be false for HTTP localhost
    httpOnly: true,
    maxAge: 30 * 60 * 1000, // 30 minutes
  },
}));

// --------------------------------------------------------------------------
// Build openid-client Issuer and Client (v4 API)
// --------------------------------------------------------------------------

let oidcClient = null; // initialised in startApp()

async function buildOidcClient() {
  // For HS256 MVP: do NOT set jwks_uri — openid-client cannot load symmetric keys
  // from a public JWKS URL and will throw "no applicable keys" during token validation.
  // App F verifies ID Tokens using client_secret directly.
  const issuer = new Issuer({
    issuer:                               PID_ISSUER,
    authorization_endpoint:              `${PID_ISSUER}/authorize`,
    token_endpoint:                      `${PID_ISSUER}/token`,
    userinfo_endpoint:                   `${PID_ISSUER}/userinfo`,
    // jwks_uri intentionally omitted for HS256 MVP
    response_types_supported:             ["code"],
    subject_types_supported:              ["public"],
    id_token_signing_alg_values_supported:["HS256"],
    scopes_supported:                     ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported:["client_secret_post"],
  });

  const client = new issuer.Client({
    client_id:                    CLIENT_ID,
    client_secret:                CLIENT_SECRET,   // used as HS256 HMAC verify key
    redirect_uris:                [REDIRECT_URI],
    response_types:               ["code"],
    id_token_signed_response_alg: "HS256",         // must match PID's algorithm
    token_endpoint_auth_method:   "client_secret_post", // PID expects creds in POST body
                                                        // default is client_secret_basic (header)
                                                        // which PID will reject with 401
  });

  return client;
}

// --------------------------------------------------------------------------
// Middleware: require App F session
// --------------------------------------------------------------------------
function requireAppFSession(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect("/login");
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

// GET / — redirect to dashboard or login
app.get("/", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/dashboard");
  return res.redirect("/login");
});

// GET /login — show login page with OIDC SSO button
app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/dashboard");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accops Workspace — OIDC Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: #f3f4f6;
      color: #1f2937;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      width: 400px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .brand-logo {
      font-size: 24px;
      font-weight: 700;
      color: #1e3a8a;
      margin-bottom: 8px;
    }
    .badge {
      display: inline-block;
      background-color: #dbeafe;
      color: #1e40af;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-radius: 9999px;
      padding: 4px 12px;
      margin-bottom: 20px;
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #111827; }
    p  { color: #6b7280; font-size: 14px; margin-bottom: 30px; line-height: 1.5; }
    .btn-oidc {
      display: block;
      width: 100%;
      padding: 12px;
      background-color: #2563eb;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      border-radius: 6px;
      border: none;
      transition: background-color 0.2s;
    }
    .btn-oidc:hover { background-color: #1d4ed8; }
    .note {
      margin-top: 24px;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand-logo">Accops Workspace</div>
    <div class="badge">Single Sign-On</div>
    <h1>Enterprise Login</h1>
    <p>Authentication for Accops internal tools is centralized via OpenID Connect (OIDC).</p>
    <a href="/oidc/login" class="btn-oidc" id="btn-oidc-login">🔐 Log in with Accops SSO</a>
    <div class="note">
      OIDC Authorization Code Flow &bull; Secure HS256
    </div>
  </div>
</body>
</html>
  `);
});

// GET /oidc/login — initiate OIDC authorization code flow
// CRITICAL: openid-client generates state/nonce but does NOT save them.
//           We MUST save them to session before redirecting.
//           Without this, /callback throws "checks.state argument is missing".
app.get("/oidc/login", (req, res) => {
  if (!oidcClient) {
    return res.status(503).send("OIDC client not initialized yet. Retry in a moment.");
  }

  const state = generators.state();
  const nonce = generators.nonce();

  // Save to session BEFORE redirect — needed in /callback
  req.session.oidc_state = state;
  req.session.oidc_nonce = nonce;

  const authUrl = oidcClient.authorizationUrl({
    scope: "openid profile email",
    state,
    nonce,
  });

  console.log(`[App-F] /oidc/login: redirecting to PID authorization endpoint`);
  return res.redirect(authUrl);
});

// GET /callback — receive code from PID, exchange for tokens
// CRITICAL: Both state and nonce must come from session and be passed to client.callback().
//           Missing either causes an immediate throw from openid-client.
app.get("/callback", async (req, res) => {
  if (!oidcClient) {
    return res.status(503).send("OIDC client not initialized.");
  }

  try {
    const params = oidcClient.callbackParams(req);

    const tokenSet = await oidcClient.callback(
      REDIRECT_URI,
      params,
      {
        state: req.session.oidc_state,  // retrieve from session (saved in /oidc/login)
        nonce: req.session.oidc_nonce,  // retrieve from session (saved in /oidc/login)
      }
    );

    // Clear OIDC flow state from session — no longer needed after successful exchange
    delete req.session.oidc_state;
    delete req.session.oidc_nonce;

    const claims = tokenSet.claims();
    console.log(`[App-F] /callback: token exchange successful, sub=${claims.sub}`);

    // Create App F local session
    req.session.user = {
      username:    claims.preferred_username || claims.name || claims.sub,
      email:       claims.email || `${claims.sub}@example.local`,
      sub:         claims.sub,
      issuer:      claims.iss,
      loginTime:   Date.now(),
      loginMethod: "OIDC Authorization Code",
    };

    return res.redirect("/dashboard");

  } catch (err) {
    console.error(`[App-F] /callback error: ${err.message}`);
    return res.status(401).send(`
      <h2>Authentication Failed</h2>
      <p><strong>Error:</strong> ${err.message}</p>
      <p><a href="/login">Try again</a></p>
    `);
  }
});

// GET /dashboard — requires App F session
app.get("/dashboard", requireAppFSession, (req, res) => {
  const u = req.session.user;
  const loginTime = new Date(u.loginTime).toLocaleString();
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accops Workspace — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      min-height: 100vh;
    }
    .navbar {
      background-color: #ffffff;
      border-bottom: 1px solid #e5e7eb;
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .navbar-brand {
      font-size: 18px;
      font-weight: 700;
      color: #1e3a8a;
    }
    .user-profile {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 14px;
    }
    .user-profile span {
      color: #4b5563;
    }
    .btn-logout-nav {
      padding: 6px 12px;
      background-color: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      color: #374151;
      text-decoration: none;
      font-weight: 500;
      font-size: 12px;
      transition: background-color 0.2s;
    }
    .btn-logout-nav:hover {
      background-color: #e5e7eb;
    }
    .container {
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .welcome-banner {
      background-color: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .welcome-banner h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #111827;
    }
    .welcome-banner p {
      font-size: 14px;
      color: #6b7280;
    }
    .grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
    }
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .card {
      background-color: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #111827;
      border-bottom: 1px solid #f3f4f6;
      padding-bottom: 8px;
    }
    .service-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .service-item:last-child {
      border-bottom: none;
    }
    .service-icon {
      width: 40px;
      height: 40px;
      border-radius: 6px;
      background-color: #eff6ff;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #2563eb;
      font-size: 18px;
      font-weight: bold;
    }
    .service-info {
      flex: 1;
    }
    .service-name {
      font-size: 14px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 2px;
    }
    .service-desc {
      font-size: 12px;
      color: #6b7280;
    }
    .btn-launch {
      padding: 6px 12px;
      background-color: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }
    .btn-launch:hover {
      background-color: #1d4ed8;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #f3f4f6;
      font-size: 13px;
    }
    .info-row:last-child {
      border-bottom: none;
    }
    .info-label {
      color: #6b7280;
    }
    .info-value {
      color: #374151;
      font-weight: 500;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="navbar-brand">Accops Workspace</div>
    <div class="user-profile">
      <span>👤 ${u.username}</span>
      <a href="/logout" class="btn-logout-nav" id="btn-logout">Logout</a>
    </div>
  </nav>

  <div class="container">
    <div class="welcome-banner">
      <h1>Welcome to Accops Secure Portal</h1>
      <p>Your session is managed and secured using Single Sign-On (OIDC).</p>
    </div>

    <div class="grid">
      <!-- Main services column -->
      <div>
        <div class="card">
          <h2 class="card-title">Available Applications & Services</h2>
          
          <div class="service-item">
            <div class="service-icon">📁</div>
            <div class="service-info">
              <div class="service-name">Accops File Share</div>
              <div class="service-desc">Secure enterprise storage and document collaboration platform.</div>
            </div>
            <button class="btn-launch" onclick="alert('Accessing Accops File Share...')">Launch</button>
          </div>

          <div class="service-item">
            <div class="service-icon">🖥️</div>
            <div class="service-info">
              <div class="service-name">Virtual Desktop Access (VDA)</div>
              <div class="service-desc">Connect to your secure remote corporate desktop environment.</div>
            </div>
            <button class="btn-launch" onclick="alert('Launching Virtual Desktop...')">Launch</button>
          </div>

          <div class="service-item">
            <div class="service-icon">🎫</div>
            <div class="service-info">
              <div class="service-name">Accops Support Desk</div>
              <div class="service-desc">Create support tickets, view documentation, and request access.</div>
            </div>
            <button class="btn-launch" onclick="alert('Opening Support Desk...')">Open</button>
          </div>
        </div>
      </div>

      <!-- Technical OIDC details column -->
      <div>
        <div class="card">
          <h2 class="card-title">OIDC Session Details</h2>
          
          <div class="info-row">
            <span class="info-label">User ID (sub)</span>
            <span class="info-value">${u.sub}</span>
          </div>

          <div class="info-row">
            <span class="info-label">Email</span>
            <span class="info-value">${u.email}</span>
          </div>

          <div class="info-row">
            <span class="info-label">OIDC Issuer</span>
            <span class="info-value" style="font-size:11px;">${u.issuer}</span>
          </div>

          <div class="info-row">
            <span class="info-label">Auth Method</span>
            <span class="info-value">${u.loginMethod}</span>
          </div>

          <div class="info-row">
            <span class="info-label">Login Time</span>
            <span class="info-value" style="font-size:11px;">${loginTime}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `);
});

// GET /logout — destroy only App F session (PID session remains active)
app.get("/logout", (req, res) => {
  const username = req.session?.user?.username || "unknown";
  req.session.destroy(() => {
    console.log(`[App-F] Logged out: ${username}`);
    res.redirect("/login");
  });
});

// --------------------------------------------------------------------------
// Start server
// --------------------------------------------------------------------------
async function startApp() {
  try {
    oidcClient = await buildOidcClient();
    console.log("[App-F] OIDC client initialized successfully");
  } catch (err) {
    console.error(`[App-F] Failed to initialize OIDC client: ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, "127.0.0.1", () => {
    console.log("============================================");
    console.log(`App F (OIDC Relying Party) running at http://localhost:${PORT}`);
    console.log(`Login page: http://localhost:${PORT}/login`);
    console.log(`PID OIDC Provider: ${PID_ISSUER}`);
    console.log("============================================");
  });
}

startApp();
