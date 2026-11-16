// Catalog images (sprint 8). A product image that fails to load is replaced by
// the same "No image" placeholder the page shows when there is no URL at all,
// instead of the browser's broken-image icon.
(function () {
  function placeholder(img) {
    var box = document.createElement('span');
    box.className = img.className + ' product-image--missing';
    if (img.alt) {
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', 'No image available');
    } else {
      box.setAttribute('aria-hidden', 'true');
    }
    var label = document.createElement('span');
    label.className = 'product-image__label';
    label.textContent = 'No image';
    box.appendChild(label);
    img.parentNode.replaceChild(box, img);
  }

  Array.prototype.forEach.call(document.querySelectorAll('img[data-fallback]'), function (img) {
    // An image can fail before this deferred script runs.
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) placeholder(img);
    else img.addEventListener('error', function () { placeholder(img); });
  });
})();
