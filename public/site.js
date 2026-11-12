// Header behavior. The nav works without this file (the dropdowns are
// <details> elements), this only adds polish: one open menu at a time, close
// on outside click or Escape, and the mobile menu toggle.
(function () {
  var nav = document.getElementById('site-nav');
  var toggle = document.querySelector('.nav-toggle');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var menus = Array.prototype.slice.call(document.querySelectorAll('details.site-menu'));
  function closeAll(except) {
    menus.forEach(function (menu) { if (menu !== except) menu.open = false; });
  }
  menus.forEach(function (menu) {
    menu.addEventListener('toggle', function () { if (menu.open) closeAll(menu); });
  });
  document.addEventListener('click', function (event) {
    menus.forEach(function (menu) { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAll();
  });

  // Story AA-74: these two behaviors used to be onchange= and onsubmit=
  // attributes in the templates. The content security policy refuses to run an
  // attribute like that -- which is the point, since an injected value could
  // carry one -- so they live here, in a file the policy trusts.
  var list = function (selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  };

  // A filter dropdown that submits its form as soon as the choice changes.
  list('select[data-autosubmit]').forEach(function (select) {
    select.addEventListener('change', function () {
      if (select.form) select.form.submit();
    });
  });

  // A read-only setup link that selects itself, ready to copy. This was an
  // inline onfocus attribute, which the policy refused to run.
  list('input[data-select-on-focus]').forEach(function (input) {
    input.addEventListener('focus', function () { input.select(); });
  });

  // A form that must not be sent twice, such as confirming a purchase: the
  // button is disabled once it has been clicked. The server refuses a second
  // confirmation anyway; this just saves the extra round trip.
  list('form[data-submit-once]').forEach(function (form) {
    form.addEventListener('submit', function () {
      Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (button) {
        setTimeout(function () { button.disabled = true; }, 0);
      });
    });
  });

  // A set of forms where only one submission can be in flight: the Add to
  // cart buttons across a catalog page. Each one navigates, so a second click
  // before the page comes back is a second request writing the same session,
  // and whichever finishes last wins -- an item the driver watched themselves
  // add, gone. Submitting any of them disables the lot.
  list('form[data-submit-group]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var group = form.getAttribute('data-submit-group');
      list('form[data-submit-group="' + group + '"] button[type="submit"]').forEach(function (button) {
        // After the submit, so disabling cannot cancel it.
        setTimeout(function () { button.disabled = true; }, 0);
      });
    });
  });

  // The back button restores a page from the cache exactly as it was left,
  // disabled buttons and all, which would leave the driver with a catalog
  // they cannot add anything from.
  window.addEventListener('pageshow', function () {
    list('form[data-submit-once] button[type="submit"], form[data-submit-group] button[type="submit"]')
      .forEach(function (button) { button.disabled = false; });
  });

  // A form that asks before it does something irreversible. Without scripting
  // the form still submits, exactly as it did with the attribute.
  list('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });
})();
