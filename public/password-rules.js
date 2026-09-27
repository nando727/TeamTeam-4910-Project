// Live checklist for the password-rules partial. The rules are read from the
// page (rendered from src/auth/password-policy.js), never duplicated here, so
// the browser and the server always agree. A submit that would fail is blocked
// with a message naming the rule; the server re-checks everything anyway.
(function () {
  document.querySelectorAll('[data-password-rules]').forEach(function (list) {
    var input = document.getElementById(list.getAttribute('data-for'));
    if (!input || !input.form) return;
    var form = input.form;
    var confirm = form.querySelector('[data-confirm-for="' + input.id + '"]');
    var rules = Array.prototype.map.call(list.querySelectorAll('[data-rule]'), function (li) {
      return { li: li, re: new RegExp(li.getAttribute('data-pattern')), label: li.textContent.trim() };
    });

    var notice = document.createElement('p');
    notice.className = 'error';
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    list.parentNode.insertBefore(notice, list.nextSibling);

    function evaluate() {
      var failed = [];
      rules.forEach(function (rule) {
        var met = rule.re.test(input.value);
        rule.li.classList.toggle('is-met', met);
        rule.li.classList.toggle('is-unmet', !met && input.value.length > 0);
        if (!met) failed.push(rule.label);
      });
      return failed;
    }

    function hideNotice() { notice.hidden = true; }
    input.addEventListener('input', function () { evaluate(); hideNotice(); });
    if (confirm) confirm.addEventListener('input', hideNotice);

    form.addEventListener('submit', function (event) {
      var failed = evaluate();
      var message = '';
      if (failed.length) {
        message = 'Password does not meet ' + (failed.length === 1 ? 'this rule: ' : 'these rules: ') + failed.join('; ') + '.';
      } else if (confirm && confirm.value !== input.value) {
        message = 'The new password and confirmation do not match.';
      }
      if (message) {
        event.preventDefault();
        notice.textContent = message;
        notice.hidden = false;
        (failed.length ? input : confirm).focus();
      }
    });

    evaluate();
  });
})();
