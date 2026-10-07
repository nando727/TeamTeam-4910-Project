const express = require('express');
const db = require('../db');
const { VALID_ROLES, DuplicateError, createUser, updateUserContact } = require('../users/store');
const { createSponsor } = require('../sponsors/store');
const { getAbout } = require('../about/store');
const { passwordProblems } = require('../auth/password-policy');

const { requireApiLogin, requireApiRole } = require('../auth/api-guard');
const { findUserById } = require('../users/store');

const router = express.Router();

router.post('/api/sponsors', requireApiLogin, requireApiRole('admin'), async (req, res, next) => {
  try {
    const name = (req.body.name || req.body.organizationName || '').trim();
    const contactEmail = (req.body.contactEmail || req.body.email || '').trim();
    const contactPhone = (req.body.contactPhone || '').trim();
    const address = (req.body.address || '').trim();

    if (!name || !contactEmail || !address) {
      return res.status(400).json({
        error: 'name, contact email, and address are required.',
      });
    }

    try {
      const sponsor = await createSponsor({ name, contactEmail, contactPhone, address });
      return res.status(201).json(sponsor);
    } catch (err) {
      if (err instanceof DuplicateError) return res.status(409).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post('/api/users', requireApiLogin, requireApiRole('admin'), async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const role = (req.body.role || '').trim();

    if (!name || !email || !username || !password || !role) {
      return res.status(400).json({
        error: 'name, email, username, password, and role are required.',
      });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        error: `role must be one of: ${VALID_ROLES.join(', ')}`,
      });
    }
    const problems = passwordProblems(password);
    if (problems.length) {
      return res.status(400).json({ error: problems.join(' ') });
    }

    try {
      const user = await createUser({ name, email, username, password, role });
      return res.status(201).json(user);
    } catch (err) {
      if (err instanceof DuplicateError) return res.status(409).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// Story 22251: the profile endpoints act on whoever is signed in. They used to
// read and write "the first seeded admin" regardless of the caller, so any
// session could edit that administrator's name and email.
router.get('/api/profile', requireApiLogin, async (req, res, next) => {
  try {
    const profile = await findUserById(req.session.user.id);
    if (!profile) {
      // The session points at an account that no longer exists.
      return res.status(404).json({ error: 'Your account could not be found.' });
    }
    return res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.put('/api/profile', requireApiLogin, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required.' });
    }

    try {
      // The id comes from the session, never from the request body, so a
      // caller cannot aim this at someone else's account.
      const updated = await updateUserContact(req.session.user.id, { name, email });
      if (!updated) return res.status(404).json({ error: 'Your account could not be found.' });
      return res.json(updated);
    } catch (err) {
      if (err instanceof DuplicateError) return res.status(409).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get('/api/about', async (req, res, next) => {
  try {
    const about = await getAbout();
    if (!about) {
      return res.status(404).json({ error: 'About info has not been seeded yet.' });
    }
    return res.json(about);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
