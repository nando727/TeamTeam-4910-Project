// Loading indicator for the report pages (story AD-61). The reports are
// rendered by the server, so this only shows that work is in progress between
// clicking and the next page arriving. Everything works without it.
(function () {
  var status = document.getElementById('report-status');
  if (!status) return;
  var text = status.querySelector('.report-status__text');
  var buttons = document.querySelectorAll('[data-report-form] button');
  var timer = null;

  function busy(message) {
    text.textContent = message || 'Generating report…';
    status.hidden = false;
    buttons.forEach(function (button) { button.disabled = true; });
  }
  function idle() {
    status.hidden = true;
    buttons.forEach(function (button) { button.disabled = false; });
    if (timer) { clearTimeout(timer); timer = null; }
  }

  document.querySelectorAll('[data-report-form]').forEach(function (form) {
    form.addEventListener('submit', function () { busy('Generating report…'); });
  });
  document.querySelectorAll('a[data-busy]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      busy(link.getAttribute('data-busy'));
      // A download does not navigate away, so clear the indicator on its own.
      var reset = Number(link.getAttribute('data-busy-reset'));
      if (reset > 0) timer = setTimeout(idle, reset);
    });
  });
  // Coming back with the browser's back button restores the page from cache.
  window.addEventListener('pageshow', idle);
})();
