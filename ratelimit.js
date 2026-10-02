'use strict';
const { db } = require('../db');

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function recordLoginAttempt(email, ip, success) {
  db.prepare('INSERT INTO login_attempts (email, ip, success) VALUES (?, ?, ?)').run(email.toLowerCase(), ip, success ? 1 : 0);
}

// Blocks by email+ip combination after MAX_ATTEMPTS failed logins within WINDOW_MINUTES.
function isLoginBlocked(email, ip) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM login_attempts
    WHERE email = ? AND ip = ? AND success = 0
      AND created_at >= datetime('now', ?)
  `).get(email.toLowerCase(), ip, `-${WINDOW_MINUTES} minutes`);
  return row.c >= MAX_ATTEMPTS;
}

module.exports = { recordLoginAttempt, isLoginBlocked, WINDOW_MINUTES, MAX_ATTEMPTS };
