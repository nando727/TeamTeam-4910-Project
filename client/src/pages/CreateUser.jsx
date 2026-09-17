import { useState } from 'react'
import './CreateUser.css'

const ROLES = ['driver', 'sponsor', 'admin']

const EMPTY_FORM = {
  name: '',
  email: '',
  username: '',
  password: '',
  role: '',
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(form) {
  const errors = {}

  if (!form.name.trim()) errors.name = 'Name is required'
  if (!form.email.trim()) {
    errors.email = 'Email is required'
  } else if (!EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = 'Enter a valid email address'
  }
  if (!form.username.trim()) errors.username = 'Username is required'
  if (!form.password) {
    errors.password = 'Password is required'
  } else if (form.password.length < 8) {
    errors.password = 'Password must be at least 8 characters'
  }
  if (!form.role) errors.role = 'Role is required'

  return errors
}

async function createUser(newUser) {
  const response = await fetch('http://localhost:3000/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newUser),
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error((data && data.error) || 'Failed to create user')
  }

  return data
}

function CreateUser() {
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [users, setUsers] = useState([])
  const [lastCreated, setLastCreated] = useState(null)
  const [submitError, setSubmitError] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    const validationErrors = validate(form)
    setErrors(validationErrors)
    if (Object.keys(validationErrors).length > 0) {
      setLastCreated(null)
      return
    }

    const newUser = { ...form }
    setSubmitError(null)
    setIsSubmitting(true)

    try {
      const createdUser = await createUser(newUser)
      setUsers((prev) => [...prev, createdUser])
      setLastCreated(createdUser)
      setForm(EMPTY_FORM)
    } catch (error) {
      setLastCreated(null)
      setSubmitError(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="create-user-page">
      <div className="create-user-card">
        <h1>Create User</h1>
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              value={form.name}
              onChange={handleChange}
            />
            {errors.name && <p className="field-error">{errors.name}</p>}
          </div>

          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              value={form.email}
              onChange={handleChange}
            />
            {errors.email && <p className="field-error">{errors.email}</p>}
          </div>

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

          <div className="form-field">
            <label htmlFor="role">Role</label>
            <select
              id="role"
              name="role"
              value={form.role}
              onChange={handleChange}
            >
              <option value="">Select a role</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            {errors.role && <p className="field-error">{errors.role}</p>}
          </div>

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create User'}
          </button>
        </form>

        {submitError && <p className="submit-error">{submitError}</p>}

        {lastCreated && (
          <div className="success-message">
            <p className="success-title">User created successfully</p>
            <dl className="create-user-details">
              <dt>Name</dt>
              <dd>{lastCreated.name}</dd>

              <dt>Email</dt>
              <dd>{lastCreated.email}</dd>

              <dt>Username</dt>
              <dd>{lastCreated.username}</dd>

              <dt>Role</dt>
              <dd>{lastCreated.role}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  )
}

export default CreateUser
