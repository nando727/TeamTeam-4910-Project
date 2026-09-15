require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./auth/routes');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Course spec allows plain HTTP, so `secure` stays off.
    },
  })
);

app.use(authRoutes);

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Placeholder homepage; story 22200 replaces this with per-role views.
app.get('/', requireLogin, (req, res) => {
  res.render('home', { user: req.session.user });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

module.exports = { app, requireLogin };
