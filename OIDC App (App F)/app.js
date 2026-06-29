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
  <title>App F — OIDC Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    }
    .card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 16px;
      padding: 48px 40px;
      text-align: center;
      width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-block;
      background: linear-gradient(90deg, #667eea, #764ba2);
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      border-radius: 20px;
      padding: 4px 14px;
      margin-bottom: 24px;
    }
    h1 { color: #fff; font-size: 28px; margin-bottom: 8px; }
    p  { color: rgba(255,255,255,0.55); font-size: 14px; margin-bottom: 36px; }
    .btn-oidc {
      display: block;
      width: 100%;
      padding: 14px;
      background: linear-gradient(90deg, #667eea, #764ba2);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      border-radius: 10px;
      transition: opacity 0.2s, transform 0.1s;
    }
    .btn-oidc:hover { opacity: 0.9; transform: translateY(-1px); }
    .note {
      margin-top: 24px;
      font-size: 12px;
      color: rgba(255,255,255,0.35);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">OIDC Federated SSO</div>
    <h1>App F</h1>
    <p>No username or password needed here.<br>Authentication is federated to PID via OIDC.</p>
    <a href="/oidc/login" class="btn-oidc" id="btn-oidc-login">🔐 Login with PID OIDC SSO</a>
    <div class="note">
      Authorization Code flow &bull; HS256 &bull; PID Identity Provider
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
  <title>App F — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: rgba(255,255,255,0.07);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 16px;
      padding: 48px 40px;
      width: 480px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-block;
      background: linear-gradient(90deg, #43e97b, #38f9d7);
      color: #0f0c29;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      border-radius: 20px;
      padding: 4px 14px;
      margin-bottom: 24px;
    }
    h1 { color: #fff; font-size: 26px; margin-bottom: 28px; }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 14px;
    }
    .info-row:last-of-type { border-bottom: none; }
    .info-label { color: rgba(255,255,255,0.45); }
    .info-value { color: #fff; font-weight: 500; }
    .btn-logout {
      display: block;
      width: 100%;
      margin-top: 32px;
      padding: 12px;
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.7);
      text-align: center;
      text-decoration: none;
      border-radius: 10px;
      font-size: 14px;
      transition: background 0.2s;
    }
    .btn-logout:hover { background: rgba(255,255,255,0.18); }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓ OIDC SSO Active</div>
    <h1>Welcome, ${u.username}!</h1>
    <div class="info-row">
      <span class="info-label">Username</span>
      <span class="info-value">${u.username}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Email</span>
      <span class="info-value">${u.email}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Subject (sub)</span>
      <span class="info-value">${u.sub}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Issuer</span>
      <span class="info-value">${u.issuer}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Login Method</span>
      <span class="info-value">${u.loginMethod}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Session Since</span>
      <span class="info-value">${loginTime}</span>
    </div>
    <a href="/logout" class="btn-logout" id="btn-logout">Logout from App F</a>
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
