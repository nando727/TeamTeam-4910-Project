import { useEffect, useState } from 'react'
import './About.css'

function About() {
  const [about, setAbout] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadAbout() {
      try {
        const response = await fetch('http://localhost:3000/api/about')
        const data = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error((data && data.error) || 'Failed to load about info')
        }

        if (!cancelled) {
          setAbout(data)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadAbout()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="about-page">
      <div className="about-card">
        <h1>About</h1>

        {isLoading && <p className="about-status">Loading...</p>}

        {!isLoading && error && <p className="about-status about-error">{error}</p>}

        {!isLoading && !error && about && (
          <dl className="about-details">
            <dt>Team Name</dt>
            <dd>{about.team_name}</dd>

            <dt>App Version</dt>
            <dd>{about.app_version}</dd>

            <dt>Release Date</dt>
            <dd>{about.release_date}</dd>

            <dt>Description</dt>
            <dd>{about.description}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}

export default About
