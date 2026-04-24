import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { AudioProcessor } from './pages/AudioProcessor'

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<AudioProcessor />} />
      </Routes>
    </Router>
  )
}

export default App
