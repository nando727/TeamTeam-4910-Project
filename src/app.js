require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./auth/routes');
const apiRoutes = require('./routes/api');
const sponsorRoutes = require('./sponsors/routes');
const accountRoutes = require('./account/routes');
const adminRoutes = require('./admin/routes');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
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
app.use(apiRoutes);
app.use('/sponsors', sponsorRoutes);
app.use(accountRoutes);
app.use('/admin', adminRoutes);

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Story 22200: each role lands on its own homepage view.
const HOME_VIEWS = { driver: 'driver/home', sponsor: 'sponsor/home', admin: 'admin/home' };

app.get('/', requireLogin, (req, res) => {
  const view = HOME_VIEWS[req.session.user.role];
  // A session whose role isn't one of the three is not trusted with any homepage.
  if (!view) return res.status(403).send('Your account has no homepage. Contact an admin.');
  res.render(view, { user: req.session.user });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

module.exports = { app, requireLogin };
