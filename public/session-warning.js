// Story AA-12: warn before an idle session expires, with a countdown and a way
// to stay signed in.
//
// The server decides when a session dies (src/auth/session-timeout.js); this
// only mirrors that clock. Timings come from data attributes the page carries,
// so the two cannot drift apart. With scripts off nothing changes: the session
// still expires server-side and the login page still explains why.
(function () {
  var root = document.documentElement;
  var remainingMs = Number(root.getAttribute('data-session-remaining'));
  var warningMs = Number(root.getAttribute('data-session-warning'));
  if (!Number.isFinite(remainingMs) || !Number.isFinite(warningMs) || remainingMs <= 0) return;

  var expiresAt = Date.now() + remainingMs;
  var dialog = null;
  var countdownEl = null;
  var ticker = null;

  function secondsLeft() {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  function formatClock(totalSeconds) {
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function build() {
    var el = document.createElement('div');
    el.className = 'session-warning';
    // A live region so a screen reader announces it without stealing focus.
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-labelledby', 'session-warning-title');
    el.innerHTML =
      '<p class="session-warning__title" id="session-warning-title">Still there?</p>' +
      '<p class="session-warning__body">You will be signed out in ' +
      '<span class="session-warning__clock" data-countdown>0:00</span> ' +
      'because of inactivity.</p>' +
      '<div class="session-warning__actions">' +
      '<button type="button" data-stay>Stay signed in</button>' +
      '<a class="button-link button--small" href="/logout-now">Sign out</a>' +
      '</div>';
    document.body.appendChild(el);

    el.querySelector('[data-stay]').addEventListener('click', staySignedIn);
    // Signing out from here goes through the normal POST form in the header.
    el.querySelector('a[href="/logout-now"]').addEventListener('click', function (event) {
      event.preventDefault();
      var form = document.querySelector('form[action="/logout"]');
      if (form) form.submit();
      else window.location.href = '/login';
    });

    countdownEl = el.querySelector('[data-countdown]');
    return el;
  }

  function show() {
    if (!dialog) dialog = build();
    dialog.classList.add('is-visible');
    // Move focus to the button so a keyboard user can act immediately.
    var stay = dialog.querySelector('[data-stay]');
    if (stay) stay.focus();
  }

  function hide() {
    if (dialog) dialog.classList.remove('is-visible');
  }

  function staySignedIn() {
    var stay = dialog && dialog.querySelector('[data-stay]');
    if (stay) stay.disabled = true;

    fetch('/session/keep-alive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (response) {
        if (!response.ok) throw new Error('expired');
        return response.json();
      })
      .then(function (data) {
        expiresAt = Date.now() + Number(data.remainingMs);
        warningMs = Number(data.warningMs);
        hide();
      })
      .catch(function () {
        // The session went while we asked. Reload so the server decides what
        // the visitor sees, rather than guessing here.
        window.location.href = '/login?expired=1';
      })
      .finally(function () {
        if (stay) stay.disabled = false;
      });
  }

  function tick() {
    var msLeft = expiresAt - Date.now();

    if (msLeft <= 0) {
      clearInterval(ticker);
      // Let the server expire the session and explain it on the login page.
      window.location.href = '/';
      return;
    }

    if (msLeft <= warningMs) {
      show();
      if (countdownEl) countdownEl.textContent = formatClock(secondsLeft());
    } else {
      hide();
    }
  }

  ticker = setInterval(tick, 1000);
  tick();
})();
