// Sprint 9: a short burst of confetti on the order-complete page. No library:
// a canvas over the page, a hundred or so pieces, two and a half seconds, then
// the canvas is removed. Skipped entirely when the visitor has asked for
// reduced motion, and the page says everything it needs to without it.
(function () {
  if (!document.querySelector('[data-confetti]')) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof document.createElement('canvas').getContext !== 'function') return;

  var DURATION = 2500;
  var COUNT = 120;
  var COLORS = ['#1a5fb4', '#7fb2f0', '#1f7a3a', '#f0b429', '#d9534f', '#ffffff'];

  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:90;';
  document.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');

  function size() {
    var ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  size();
  window.addEventListener('resize', size);

  var pieces = [];
  for (var i = 0; i < COUNT; i++) {
    pieces.push({
      x: window.innerWidth * (0.3 + Math.random() * 0.4),
      y: window.innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -(6 + Math.random() * 9),
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
    });
  }

  var started = null;
  function frame(now) {
    if (started === null) started = now;
    var elapsed = now - started;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    var fade = elapsed > DURATION - 600 ? Math.max(0, (DURATION - elapsed) / 600) : 1;
    pieces.forEach(function (p) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (elapsed < DURATION) {
      window.requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', size);
      canvas.parentNode.removeChild(canvas);
    }
  }
  window.requestAnimationFrame(frame);
})();
