import './Profile.css'

const CURRENT_ADMIN = {
  name: 'Jordan Lee',
  email: 'jordan.lee@example.com',
  username: 'admin1',
  role: 'admin',
}

function Profile() {
  return (
    <div className="profile-page">
      <div className="profile-card">
        <h1>Profile</h1>
        <dl className="profile-details">
          <dt>Name</dt>
          <dd>{CURRENT_ADMIN.name}</dd>

          <dt>Email</dt>
          <dd>{CURRENT_ADMIN.email}</dd>

          <dt>Username</dt>
          <dd>{CURRENT_ADMIN.username}</dd>

          <dt>Role</dt>
          <dd>{CURRENT_ADMIN.role}</dd>
        </dl>
      </div>
    </div>
  )
}

export default Profile
