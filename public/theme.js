// Sprint 9: daylight or night, and the visitor's choice remembered.
//
// This file is loaded without `defer`, in <head>, so the saved choice is on
// <html> before anything is painted: a visitor who chose the night palette
// never sees a white flash first. The content security policy refuses inline
// scripts (story AA-74), which is why this is a file and not two lines in the
// template.
//
// With no choice saved, nothing is set and the stylesheet follows the
// computer's own setting through prefers-color-scheme. With scripts off,
// that is all that happens: the toggle stays hidden (it is shown only under
// html.theme-ready) rather than sitting there doing nothing.
(function () {
  var KEY = 'gdip-theme';
  var root = document.documentElement;

  function saved() {
    try {
      var value = window.localStorage.getItem(KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch (err) {
      // Private browsing, or storage switched off: fall back to the system.
      return null;
    }
  }

  function systemPrefersDark() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Before the first paint.
  var choice = saved();
  if (choice) root.setAttribute('data-theme', choice);
  root.classList.add('theme-ready');

  function current() {
    var attribute = root.getAttribute('data-theme');
    if (attribute === 'dark' || attribute === 'light') return attribute;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function describe(button) {
    var dark = current() === 'dark';
    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('title', label);
    var text = button.querySelector('[data-theme-label]');
    if (text) text.textContent = label;
  }

  function wire() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    Array.prototype.forEach.call(buttons, function (button) {
      describe(button);
      button.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { window.localStorage.setItem(KEY, next); } catch (err) { /* nothing to do */ }
        Array.prototype.forEach.call(buttons, describe);
      });
    });

    // Following the computer's setting means following it as it changes, for
    // anyone who has not made a choice of their own.
    if (window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (!saved()) Array.prototype.forEach.call(buttons, describe); };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
