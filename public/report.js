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

// Story AD-40: the invoice's print button. A file the content security policy
// trusts, since an inline onclick would not run.
(function () {
  Array.prototype.forEach.call(document.querySelectorAll('[data-print]'), function (button) {
    button.addEventListener('click', function () { window.print(); });
  });
})();

// Chart tooltips (story AD-31): the same details on hover, focus, and tap. The
// values are also on the chart or in the table under it, so this only adds
// convenience. Text goes in with textContent because names are user data.
(function () {
  var marks = document.querySelectorAll('.chart__mark');
  if (!marks.length) return;
  var tip = document.createElement('div');
  var value = document.createElement('strong');
  var label = document.createElement('span');
  tip.className = 'chart-tip';
  tip.hidden = true;
  tip.appendChild(value);
  tip.appendChild(label);
  document.body.appendChild(tip);

  function show(mark, x, y) {
    value.textContent = mark.getAttribute('data-tip-value');
    label.textContent = mark.getAttribute('data-tip-label');
    tip.hidden = false;
    var left = Math.min(x - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
  }
  function hide() { tip.hidden = true; }
  function showAtBar(mark) {
    var box = (mark.querySelector('.chart__bar') || mark).getBoundingClientRect();
    show(mark, box.left + box.width / 2, box.top);
  }

  marks.forEach(function (mark) {
    mark.addEventListener('pointermove', function (event) { show(mark, event.clientX, event.clientY); });
    mark.addEventListener('pointerleave', hide);
    mark.addEventListener('focus', function () { showAtBar(mark); });
    mark.addEventListener('blur', hide);
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(); });
  // Tabbing to a mark can scroll the page, so a keyboard user's tooltip follows
  // the mark. Otherwise a tooltip left behind by scrolling would float over nothing.
  window.addEventListener('scroll', function () {
    var active = document.activeElement;
    if (active && active.matches('.chart__mark:focus-visible')) showAtBar(active);
    else hide();
  }, { passive: true });
})();
