const express = require('express');
const db = require('../db');
const { VALID_ROLES, DuplicateError, createUser, updateUserContact } = require('../users/store');
const { createSponsor } = require('../sponsors/store');
const { getAbout } = require('../about/store');

const router = express.Router();

router.post('/api/sponsors', async (req, res, next) => {
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

router.post('/api/users', async (req, res, next) => {
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

// The API profile is the first seeded admin until the React client has sessions.
async function findFirstAdmin() {
  const rows = await db.query(
    "SELECT id, name, email, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

router.get('/api/profile', async (req, res, next) => {
  try {
    const profile = await findFirstAdmin();
    if (!profile) {
      return res.status(404).json({ error: 'No admin user has been seeded yet.' });
    }
    return res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.put('/api/profile', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required.' });
    }

    const profile = await findFirstAdmin();
    if (!profile) {
      return res.status(404).json({ error: 'No admin user has been seeded yet.' });
    }

    try {
      const updated = await updateUserContact(profile.id, { name, email });
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
