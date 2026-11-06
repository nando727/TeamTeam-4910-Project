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

  // A form that asks before it does something irreversible. Without scripting
  // the form still submits, exactly as it did with the attribute.
  list('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });
})();
