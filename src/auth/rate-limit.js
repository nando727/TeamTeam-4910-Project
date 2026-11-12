// A small sliding-window throttle for anonymous forms, used by the driver
// sign-up page so it cannot be used to fill the users table from a script.
//
// It lives in this process's memory, not the database, on purpose: a sign-up
// that is refused leaves no row behind to count (unlike a sign-in attempt or a
// reset link), and a table for refused sign-ups would be a table that grows
// with every abuse attempt. The cost is that the count starts over when the
// server restarts and is per instance behind a load balancer. For a sign-up
// form that is the right trade: the worst case after a deploy is one more
// window of attempts from one address.
//
// Keys are whatever the caller passes, normally the request's source address
// from src/auth/request-source.js. An unknown source (null) shares one bucket,
// which is strict rather than lenient: requests the app cannot attribute get
// the allowance of a single address between them.

const DEFAULT_MAX_PER_WINDOW = 5;
const DEFAULT_WINDOW_MINUTES = 15;

function createRateLimiter({ max = DEFAULT_MAX_PER_WINDOW, windowMs = DEFAULT_WINDOW_MINUTES * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();

  // Drops timestamps that have left the window; forgets keys with none left so
  // the map does not grow with every address that ever visited.
  function recent(key, at) {
    const times = (hits.get(key) || []).filter(t => t > at - windowMs);
    if (times.length) hits.set(key, times); else hits.delete(key);
    return times;
  }

  return {
    // Whether `key` may proceed right now, and if not, how long until it may.
    // Does not record anything: call hit() when the attempt actually happens.
    check(key) {
      const at = now();
      const times = recent(String(key), at);
      if (times.length < max) return { allowed: true, remaining: max - times.length, retryAfterMs: 0 };
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, times[0] + windowMs - at) };
    },
    // Records an attempt against `key`.
    hit(key) {
      const at = now();
      const times = recent(String(key), at);
      times.push(at);
      hits.set(String(key), times);
    },
    // For tests and for an administrator-driven reset, should one be wanted.
    reset(key) {
      if (key === undefined) hits.clear(); else hits.delete(String(key));
    },
    size() { return hits.size; },
  };
}

// Read per call so a demo or a test can use a short window without a restart.
function signupPolicy() {
  const max = Number.parseInt(process.env.SIGNUP_MAX_PER_WINDOW, 10);
  const minutes = Number.parseFloat(process.env.SIGNUP_WINDOW_MINUTES);
  return {
    max: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_PER_WINDOW,
    windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES,
  };
}

module.exports = { createRateLimiter, signupPolicy, DEFAULT_MAX_PER_WINDOW, DEFAULT_WINDOW_MINUTES };
