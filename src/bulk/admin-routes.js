const express = require('express');
const path = require('path');
const Busboy = require('busboy');
const { requireActiveAdmin } = require('../admin/guard');
const { formToken } = require('../auth/form-token');
const { setupLinkFor } = require('../auth/setup-tokens');
const { describeFormat, parseStream } = require('./parser');
const { BulkLoader } = require('./loader');

// RC#1: admin bulk upload. Mounted on its own (not inside the admin router)
// because the upload is multipart and is streamed, so the usual urlencoded
// form-token check cannot see the token; it is checked from the stream instead.
const router = express.Router();
router.use(requireActiveAdmin);

const SAMPLE_PATH = path.join(__dirname, '..', '..', 'docs', 'bulk-upload-sample.txt');

function render(req, res, { result = null, error = null, status = 200 } = {}) {
  res.status(status).render('admin/bulk-upload', { token: formToken(req), format: describeFormat(), result, error });
}

router.get('/', (req, res) => render(req, res));

router.get('/sample.txt', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bulk-upload-sample.txt"');
  res.type('text/plain').sendFile(SAMPLE_PATH);
});

router.post('/', (req, res, next) => {
  let busboy;
  try {
    // No fileSize limit on purpose (RC#1 story 7); one file, a few fields.
    busboy = Busboy({ headers: req.headers, limits: { files: 1, fields: 10, fieldSize: 1024 } });
  } catch (err) {
    return render(req, res, { error: 'Choose a file to upload.', status: 400 });
  }

  let tokenOk = false;
  let fileSeen = false;
  let filename = null;
  let processing = Promise.resolve();
  const loader = new BulkLoader({
    actor: { id: req.session.user.id, role: req.session.user.role, sponsorId: req.session.user.sponsorId || null },
    linkFor: rawToken => setupLinkFor(req, rawToken),
  });

  busboy.on('field', (name, value) => {
    if (name === 'token') tokenOk = value === req.session.formToken;
  });

  busboy.on('file', (name, stream, info) => {
    if (name !== 'file' || fileSeen) { stream.resume(); return; }
    fileSeen = true;
    filename = info.filename || 'upload.txt';
    if (!tokenOk) { stream.resume(); return; }
    // Rows are applied as the file streams in; the whole file is never held in memory.
    processing = (async () => {
      await loader.start();
      for await (const item of parseStream(stream)) await loader.apply(item);
    })();
    // Keep the stream flowing even if a database call rejects; the error is reported below.
    processing.catch(() => stream.resume());
  });

  busboy.on('error', next);
  busboy.on('close', async () => {
    try {
      if (!fileSeen) return render(req, res, { error: 'Choose a file to upload.', status: 400 });
      if (!tokenOk) return res.status(403).send('Invalid form. Reload the page and try again.');
      await processing;
      render(req, res, { result: { filename, summary: loader.summary, rows: loader.results } });
    } catch (err) { next(err); }
  });

  req.pipe(busboy);
});

module.exports = router;
