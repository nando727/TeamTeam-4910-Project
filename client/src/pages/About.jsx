import './About.css'

const TEAM_NAME = 'F26-Team13'
const APP_VERSION = '1.0.0'
const RELEASE_DATE = '2026-09-15'
const PRODUCT_DESCRIPTION =
  'A driver incentive web app that lets sponsor companies reward truck drivers with points redeemable for products, with admin tools to manage sponsors, drivers, and applications.'

function About() {
  return (
    <div className="about-page">
      <div className="about-card">
        <h1>About</h1>
        <dl className="about-details">
          <dt>Team Name</dt>
          <dd>{TEAM_NAME}</dd>

          <dt>App Version</dt>
          <dd>{APP_VERSION}</dd>

          <dt>Release Date</dt>
          <dd>{RELEASE_DATE}</dd>

          <dt>Description</dt>
          <dd>{PRODUCT_DESCRIPTION}</dd>
        </dl>
      </div>
    </div>
  )
}

export default About
