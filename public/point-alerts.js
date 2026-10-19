// Load point-change alerts on each driver page; dismissals are saved per account.
fetch('/points/alerts')
  .then(response => {
    if (!response.ok || response.redirected) throw new Error('Alerts unavailable');
    return response.text();
  })
  .then(html => { document.getElementById('point-alerts').innerHTML = html; })
  .catch(() => {
    document.getElementById('point-alerts').textContent = 'Point alerts could not be loaded. Refresh to try again.';
  });
