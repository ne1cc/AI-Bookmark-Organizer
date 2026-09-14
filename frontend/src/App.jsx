import Organizer from './components/Organizer'
import ThemeToggle from './components/ThemeToggle'
import RemoveDuplicatesButton from './components/RemoveDuplicatesButton'
import { useTheme } from './hooks/useTheme'
import { useZoom } from './hooks/useZoom'
import { X } from 'lucide-react'
import ZoomControl from './components/ZoomControl'

function App() {
  const { theme, isMinimal, setTheme } = useTheme()
  const { zoom, increase, decrease, reset } = useZoom()

  const handleClose = () => {
    const shouldClose = window.confirm('Close the app? This will stop any current runs and clear their data.')
    if (!shouldClose) return

    try {
      window.dispatchEvent(new CustomEvent('extension-close-requested'))
    } catch {}
    window.close()
  }

  return (
    <div className={`app-container ${isMinimal ? 'is-minimal-mode' : ''}`}>
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
          {isMinimal && (
            <span className="minimal-mode-badge" title="Extra Minimal Redesign Active">
              MINIMAL
            </span>
          )}
          <p className="header-subtitle">
            Transform your chaos into a curated library
          </p>
        </div>
      </header>

      <main className="app-main">
        <Organizer isMinimal={isMinimal} />
      </main>
    </div>
  )
}

export default App
