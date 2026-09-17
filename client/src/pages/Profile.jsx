import { useEffect, useState } from 'react'
import './Profile.css'

async function fetchProfile() {
  const response = await fetch('http://localhost:3000/api/profile')
  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error((data && data.error) || 'Failed to load profile')
  }

  return data
}

async function saveProfile(updates) {
  const response = await fetch('http://localhost:3000/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error((data && data.error) || 'Failed to save profile')
  }

  return data
}

function Profile() {
  const [profile, setProfile] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [isEditing, setIsEditing] = useState(false)
  const [form, setForm] = useState({ name: '', email: '' })
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadProfile() {
      try {
        const data = await fetchProfile()
        if (!cancelled) {
          setProfile(data)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadProfile()

    return () => {
      cancelled = true
    }
  }, [])

  const handleEditClick = () => {
    setForm({ name: profile.name || '', email: profile.email || '' })
    setSaveError(null)
    setSaveSuccess(false)
    setIsEditing(true)
  }

  const handleCancelClick = () => {
    setIsEditing(false)
    setSaveError(null)
  }

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const handleSave = async (event) => {
    event.preventDefault()
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    try {
      const updated = await saveProfile(form)
      setProfile(updated)
      setIsEditing(false)
      setSaveSuccess(true)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="profile-page">
      <div className="profile-card">
        <h1>Profile</h1>

        {isLoading && <p className="profile-status">Loading...</p>}

        {!isLoading && loadError && <p className="profile-status profile-error">{loadError}</p>}

        {!isLoading && !loadError && profile && !isEditing && (
          <>
            <dl className="profile-details">
              <dt>Name</dt>
              <dd>{profile.name}</dd>

              <dt>Email</dt>
              <dd>{profile.email}</dd>

              <dt>Username</dt>
              <dd>{profile.username}</dd>

              <dt>Role</dt>
              <dd>{profile.role}</dd>
            </dl>

            {saveSuccess && <p className="profile-success">Profile updated successfully</p>}

            <button type="button" className="edit-button" onClick={handleEditClick}>
              Edit
            </button>
          </>
        )}

        {!isLoading && !loadError && profile && isEditing && (
          <form onSubmit={handleSave} noValidate>
            <div className="form-field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                name="name"
                type="text"
                value={form.name}
                onChange={handleChange}
              />
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
            </div>

            {saveError && <p className="profile-status profile-error">{saveError}</p>}

            <div className="profile-actions">
              <button type="submit" disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button type="button" onClick={handleCancelClick} disabled={isSaving}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default Profile
