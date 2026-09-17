import { useState } from 'react'
import './CreateSponsor.css'

const EMPTY_FORM = {
  organizationName: '',
  contactEmail: '',
  contactPhone: '',
  address: '',
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(form) {
  const errors = {}

  if (!form.organizationName.trim()) {
    errors.organizationName = 'Organization name is required'
  }
  if (!form.contactEmail.trim()) {
    errors.contactEmail = 'Contact email is required'
  } else if (!EMAIL_PATTERN.test(form.contactEmail.trim())) {
    errors.contactEmail = 'Enter a valid email address'
  }
  if (!form.contactPhone.trim()) {
    errors.contactPhone = 'Contact phone is required'
  }
  if (!form.address.trim()) {
    errors.address = 'Address is required'
  }

  return errors
}

async function createSponsor(newSponsor) {
  const response = await fetch('http://localhost:3000/api/sponsors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newSponsor),
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error((data && data.error) || 'Failed to create sponsor')
  }

  return data
}

function CreateSponsor() {
  const [form, setForm] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [sponsors, setSponsors] = useState([])
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

    const newSponsor = { ...form }
    setSubmitError(null)
    setIsSubmitting(true)

    try {
      const createdSponsor = await createSponsor(newSponsor)
      const displaySponsor = {
        organizationName: createdSponsor.name,
        contactEmail: createdSponsor.contactEmail,
        contactPhone: createdSponsor.contactPhone,
        address: createdSponsor.address,
      }
      setSponsors((prev) => [...prev, displaySponsor])
      setLastCreated(displaySponsor)
      setForm(EMPTY_FORM)
    } catch (error) {
      setLastCreated(null)
      setSubmitError(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="create-sponsor-page">
      <div className="create-sponsor-card">
        <h1>Create Sponsor</h1>
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label htmlFor="organizationName">Organization Name</label>
            <input
              id="organizationName"
              name="organizationName"
              type="text"
              value={form.organizationName}
              onChange={handleChange}
            />
            {errors.organizationName && (
              <p className="field-error">{errors.organizationName}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="contactEmail">Contact Email</label>
            <input
              id="contactEmail"
              name="contactEmail"
              type="email"
              value={form.contactEmail}
              onChange={handleChange}
            />
            {errors.contactEmail && (
              <p className="field-error">{errors.contactEmail}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="contactPhone">Contact Phone</label>
            <input
              id="contactPhone"
              name="contactPhone"
              type="tel"
              value={form.contactPhone}
              onChange={handleChange}
            />
            {errors.contactPhone && (
              <p className="field-error">{errors.contactPhone}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="address">Address</label>
            <input
              id="address"
              name="address"
              type="text"
              value={form.address}
              onChange={handleChange}
            />
            {errors.address && <p className="field-error">{errors.address}</p>}
          </div>

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Sponsor'}
          </button>
        </form>

        {submitError && <p className="submit-error">{submitError}</p>}

        {lastCreated && (
          <div className="success-message">
            <p className="success-title">Sponsor created successfully</p>
            <dl className="create-sponsor-details">
              <dt>Organization Name</dt>
              <dd>{lastCreated.organizationName}</dd>

              <dt>Contact Email</dt>
              <dd>{lastCreated.contactEmail}</dd>

              <dt>Contact Phone</dt>
              <dd>{lastCreated.contactPhone}</dd>

              <dt>Address</dt>
              <dd>{lastCreated.address}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  )
}

export default CreateSponsor
