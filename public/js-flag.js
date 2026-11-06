// Marks the page as scripted before anything is painted, so the stylesheet can
// hide the parts that only work with JavaScript (html.js rules in styles.css).
// Story AA-74 moved this out of an inline <script> in partials/head.ejs: the
// content security policy refuses inline scripts, which is the point of it.
document.documentElement.classList.add('js');
