// Load point-change and required sponsor-removal alerts on each driver page.
fetch('/points/alerts')
  .then(response => {
    if (!response.ok || response.redirected) throw new Error('Alerts unavailable');
    return response.text();
  })
  .then(html => { document.getElementById('point-alerts').innerHTML = html; })
  .catch(() => {
    document.getElementById('point-alerts').textContent = 'Alerts could not be loaded. Refresh to try again.';
  });
