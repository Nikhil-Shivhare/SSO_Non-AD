const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const path = require("path");

const app = express();
const PORT = 3003;
const SALT_ROUNDS = 10;

// Middleware
app.use(express.urlencoded({ extended: true }));

// Database setup
const db = new sqlite3.Database(path.join(__dirname, "database.sqlite"));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);
});

// HTML Templates
const loginPage = `
<!DOCTYPE html>
<html>
<head>
    <title>App-C Login</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
        button:hover { background: #0056b3; }
        .error { color: red; }
        .success { color: green; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-C - Stateless Legacy App</h1>
    <h2>Login</h2>
    <form method="POST" action="/login">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
    </form>
    <p>Don't have an account? <a href="/register">Register here</a></p>
</body>
</html>
`;

const registerPage = `
<!DOCTYPE html>
<html>
<head>
    <title>App-C Register</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #28a745; color: white; border: none; cursor: pointer; }
        button:hover { background: #1e7e34; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-C - Register</h1>
    <form method="POST" action="/register">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Register</button>
    </form>
    <p><a href="/login">Back to Login</a></p>
</body>
</html>
`;

function dashboardPage(username) {
  return `
<!DOCTYPE html>
<html>
<head>
    <title>App-C Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .welcome { background: #e7f3ff; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #ffc107; color: #333; border: none; cursor: pointer; }
        button:hover { background: #e0a800; }
        .note { color: #666; font-size: 12px; margin-top: 20px; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-C Dashboard</h1>
    <div class="welcome">
        <strong>Welcome, ${username}!</strong>
        <p>You are now logged in. Remember: this app is stateless - refreshing will require re-login.</p>
    </div>
    
    <h3>Change Password</h3>
    <form method="POST" action="/change-password">
        <input type="hidden" name="username" value="${username}">
        <input type="password" name="current_password" placeholder="Current Password" required>
        <input type="password" name="new_password" placeholder="New Password" required>
        <button type="submit">Change Password</button>
    </form>
    
    <p class="note">Note: This is a stateless app. If you refresh this page, you will be redirected to login.</p>
    <p><a href="/login">Logout (Return to Login)</a></p>
</body>
</html>
`;
}

function messagePage(title, message, isError = false) {
  const color = isError ? "red" : "green";
  return `
<!DOCTYPE html>
<html>
<head>
    <title>App-C - ${title}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; }
        .message { color: ${color}; padding: 15px; border: 1px solid ${color}; border-radius: 5px; }
        a { color: #007bff; display: block; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="message">${message}</div>
    <a href="/login">Back to Login</a>
</body>
</html>
`;
}

// Routes

// GET /login - Show login form
app.get("/login", (req, res) => {
  res.send(loginPage);
});

// GET /register - Show registration form
app.get("/register", (req, res) => {
  res.send(registerPage);
});

// POST /login - Validate credentials and return dashboard
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.send(
      messagePage("Login Failed", "Username and password are required.", true),
    );
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res.send(messagePage("Error", "Database error occurred.", true));
    }
    if (!user) {
      return res.send(
        messagePage("Login Failed", "Invalid username or password.", true),
      );
    }

    bcrypt.compare(password, user.password, (err, match) => {
      if (err || !match) {
        return res.send(
          messagePage("Login Failed", "Invalid username or password.", true),
        );
      }
      // Return dashboard directly (stateless - no session)
      res.send(dashboardPage(username));
    });
  });
});

// GET /dashboard - Redirect to login (stateless)
app.get("/dashboard", (req, res) => {
  res.redirect("/login");
});

// POST /register - Create new user
app.post("/register", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.send(
      messagePage(
        "Registration Failed",
        "Username and password are required.",
        true,
      ),
    );
  }

  bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
    if (err) {
      return res.send(messagePage("Error", "Failed to hash password.", true));
    }

    db.run(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hash],
      (err) => {
        if (err) {
          if (err.message.includes("UNIQUE constraint")) {
            return res.send(
              messagePage(
                "Registration Failed",
                "Username already exists.",
                true,
              ),
            );
          }
          return res.send(
            messagePage("Error", "Database error occurred.", true),
          );
        }
        res.send(
          messagePage(
            "Registration Successful",
            "Account created! You can now login.",
          ),
        );
      },
    );
  });
});

// POST /change-password - Change password (stateless)
app.post("/change-password", (req, res) => {
  const { username, current_password, new_password } = req.body;

  if (!username || !current_password || !new_password) {
    return res.send(messagePage("Error", "All fields are required.", true));
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err) {
      return res.send(messagePage("Error", "Database error occurred.", true));
    }
    if (!user) {
      return res.send(messagePage("Error", "User not found.", true));
    }

    bcrypt.compare(current_password, user.password, (err, match) => {
      if (err || !match) {
        return res.send(
          messagePage("Error", "Current password is incorrect.", true),
        );
      }

      bcrypt.hash(new_password, SALT_ROUNDS, (err, hash) => {
        if (err) {
          return res.send(
            messagePage("Error", "Failed to hash new password.", true),
          );
        }

        db.run(
          "UPDATE users SET password = ? WHERE username = ?",
          [hash, username],
          (err) => {
            if (err) {
              return res.send(
                messagePage("Error", "Failed to update password.", true),
              );
            }
            res.send(
              messagePage(
                "Password Changed",
                "Your password has been updated. Please login with your new password.",
              ),
            );
          },
        );
      });
    });
  });
});

// Start server
app.listen(PORT, "127.0.0.1", () => {
  console.log(`App-C running at http://localhost:${PORT}`);
  console.log("This is a STATELESS app - login required on every page refresh");
});
