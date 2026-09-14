import Organizer from './components/Organizer'
import ThemeToggle from './components/ThemeToggle'
import RemoveDuplicatesButton from './components/RemoveDuplicatesButton'
import { useTheme } from './hooks/useTheme'
import { X } from 'lucide-react'

function App() {
  const { theme, resolved, setTheme } = useTheme()

  const handleClose = () => {
    try {
      window.dispatchEvent(new CustomEvent('extension-close-requested'))
    } catch {}
    window.close()
  }

  return (
    <div className="app-container">
      <header className="app-header">
        {/* Top bar: remove duplicates on top left, theme toggle + close on top right */}
        <div className="header-top">
          <div className="header-top-left">
            <RemoveDuplicatesButton />
          </div>
          <div className="header-top-right">
            <ThemeToggle theme={theme} setTheme={setTheme} />
            <button
              onClick={handleClose}
              title="Close Extension"
              className="header-close-btn"
              aria-label="Close Extension"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Title block */}
        <div className="header-title-block">
          <h1 className="header-title">
            AI Bookmark Organizer
          </h1>
          <p className="header-subtitle">
            Transform your chaos into a curated library
          </p>
        </div>
      </header>

      <main className="app-main">
        <Organizer theme={resolved} />
      </main>
    </div>
  )
}

export default App
