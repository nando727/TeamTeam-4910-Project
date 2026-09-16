import { useState } from 'react'
import './Login.css'

const EMPTY_FORM = {
  username: '',
  password: '',
}

function validate(form) {
  const errors = {}

  if (!form.username.trim()) errors.username = 'Username is required'
  if (!form.password) errors.password = 'Password is required'

  return errors
}

// Sends the login request. The server sets a session cookie on success; the
// role isn't in the response body, it's tracked server-side via the session.
async function loginUser(username, password) {
  const response = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })

  return response.ok
}

function Login() {
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [loginStatus, setLoginStatus] = useState(null)

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    const validationErrors = validate(form)
    setErrors(validationErrors)
    if (Object.keys(validationErrors).length > 0) {
      setLoginStatus(null)
      return
    }

    try {
      const success = await loginUser(form.username, form.password)
      setLoginStatus(success ? 'success' : 'error')
    } catch {
      setLoginStatus('error')
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Login</h1>
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              value={form.username}
              onChange={handleChange}
            />
            {errors.username && (
              <p className="field-error">{errors.username}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              value={form.password}
              onChange={handleChange}
            />
            {errors.password && (
              <p className="field-error">{errors.password}</p>
            )}
          </div>

          <button type="submit">Log In</button>
        </form>

        {loginStatus === 'success' && (
          <div className="success-message">
            <p className="success-title">Login successful</p>
          </div>
        )}

        {loginStatus === 'error' && (
          <div className="error-message">
            <p className="error-title">Login failed. Check your username and password.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default Login
