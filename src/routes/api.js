const express = require('express');
const db = require('../db');
const { hashPassword } = require('../auth/password');

const router = express.Router();

const VALID_ROLES = ['driver', 'sponsor', 'admin'];

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
      const result = await db.query(
        'INSERT INTO sponsors (name, contact_email, contact_phone, address) VALUES (?, ?, ?, ?)',
        [name, contactEmail, contactPhone || null, address]
      );
      return res.status(201).json({
        id: result.insertId,
        name,
        contactEmail,
        contactPhone: contactPhone || null,
        address,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: 'A sponsor with that contact email already exists.',
        });
      }
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

    const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }

    const passwordHash = await hashPassword(password);

    try {
      const result = await db.query(
        'INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        [name, email, username, passwordHash, role]
      );
      return res.status(201).json({ id: result.insertId, name, email, username, role });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A user with that username already exists.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get('/api/profile', async (req, res, next) => {
  try {
    const rows = await db.query(
      "SELECT id, name, email, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
    );
    const profile = rows[0];
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

    const rows = await db.query(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
    );
    const profile = rows[0];
    if (!profile) {
      return res.status(404).json({ error: 'No admin user has been seeded yet.' });
    }

    try {
      await db.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [
        name,
        email,
        profile.id,
      ]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A user with that email already exists.' });
      }
      throw err;
    }

    const updatedRows = await db.query(
      'SELECT id, name, email, username, role FROM users WHERE id = ?',
      [profile.id]
    );
    return res.json(updatedRows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/api/about', async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT team_name, app_version, release_date, description FROM about ORDER BY id LIMIT 1'
    );
    const about = rows[0];
    if (!about) {
      return res.status(404).json({ error: 'About info has not been seeded yet.' });
    }
    return res.json(about);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
