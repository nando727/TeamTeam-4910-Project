import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import About from './pages/About'
import Profile from './pages/Profile'
import CreateUser from './pages/CreateUser'
import CreateSponsor from './pages/CreateSponsor'
import Login from './pages/Login'

function App() {
  return (
    <BrowserRouter>
      <nav>
        <NavLink to="/">About</NavLink>
        {' | '}
        <NavLink to="/profile">Profile</NavLink>
        {' | '}
        <NavLink to="/create-user">Create User</NavLink>
        {' | '}
        <NavLink to="/create-sponsor">Create Sponsor</NavLink>
        {' | '}
        <NavLink to="/login">Login</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<About />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/create-user" element={<CreateUser />} />
        <Route path="/create-sponsor" element={<CreateSponsor />} />
        <Route path="/login" element={<Login />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
