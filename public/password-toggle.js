// Story 22217: a Show/Hide control for password fields.
//
// The button is created here rather than written into the page, so a visitor
// without JavaScript never sees a control that does nothing. The field itself
// stays a plain <input type="password"> in the HTML.
(function () {
  var fields = document.querySelectorAll('input[type="password"][data-toggle-visibility]');

  Array.prototype.forEach.call(fields, function (input) {
    var wrapper = document.createElement('div');
    wrapper.className = 'password-field';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    var button = document.createElement('button');
    // Not a submit button: inside a form, the default type would submit it.
    button.type = 'button';
    button.className = 'password-toggle';
    button.textContent = 'Show';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', input.id);
    // The visible word is the accessible name; aria-label adds what it acts on.
    button.setAttribute('aria-label', 'Show password');

    button.addEventListener('click', function () {
      var nowVisible = input.type === 'password';

      // Changing type moves the caret to the end in some browsers, so put it back.
      var start = input.selectionStart;
      var end = input.selectionEnd;

      input.type = nowVisible ? 'text' : 'password';
      button.textContent = nowVisible ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', nowVisible ? 'true' : 'false');
      button.setAttribute('aria-label', nowVisible ? 'Hide password' : 'Show password');

      input.focus();
      if (start !== null && typeof input.setSelectionRange === 'function') {
        try { input.setSelectionRange(start, end); } catch (err) { /* not all types allow it */ }
      }
    });

    wrapper.appendChild(button);
  });
})();
