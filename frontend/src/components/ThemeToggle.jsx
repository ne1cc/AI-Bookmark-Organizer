import { createElement } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'

const options = [
    { id: 'light', icon: Sun, label: 'Light' },
    { id: 'dark', icon: Moon, label: 'Dark' },
    { id: 'system', icon: Monitor, label: 'System' },
]

/**
 * Minimalist segmented control for theme selection.
 * Light / Dark / System — driven by the useTheme hook.
 */
export default function ThemeToggle({ theme, setTheme }) {
    return (
        <div
            role="radiogroup"
            aria-label="Theme"
            className="theme-toggle"
        >
            {options.map(({ id, icon, label }) => {
                const active = theme === id
                return (
                    <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={label}
                        title={label}
                        onClick={() => setTheme(id)}
                        className={active ? 'theme-toggle-option active' : 'theme-toggle-option'}
                    >
                        {createElement(icon, { size: 16 })}
                    </button>
                )
            })}
        </div>
    )
}
