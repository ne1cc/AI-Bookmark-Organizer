import Organizer from './components/Organizer'
import ThemeToggle from './components/ThemeToggle'
import RemoveDuplicatesButton from './components/RemoveDuplicatesButton'
import { useTheme } from './hooks/useTheme'
import { useZoom } from './hooks/useZoom'
import { X } from 'lucide-react'
import { useState } from 'react'
import ZoomControl from './components/ZoomControl'

function App() {
  const { theme, resolved, setTheme } = useTheme()
  const { zoom, increase, decrease, reset } = useZoom()
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false)

  const closeApp = () => {
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
            <ZoomControl zoom={zoom} increase={increase} decrease={decrease} reset={reset} />
            <ThemeToggle theme={theme} setTheme={setTheme} />
            <button
              onClick={() => setShowCloseConfirmation(true)}
              title="Close Extension"
              className="header-close-btn"
              aria-label="Close Extension"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {showCloseConfirmation && (
          <div className="close-confirmation" role="dialog" aria-label="Close app confirmation">
            <p>Close the app? This will stop any current runs and clear their data.</p>
            <div className="close-confirmation-actions">
              <button type="button" onClick={() => setShowCloseConfirmation(false)}>Keep working</button>
              <button type="button" onClick={closeApp}>Close app</button>
            </div>
          </div>
        )}

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
