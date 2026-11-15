/**
 * Shared form controls for the side panel, styled entirely from index.css.
 *
 * Contract:
 * - Both are controlled: they render the given value and report changes, holding no state.
 *
 * Limits: accessible names come from `label`, which existing tests query by role and name.
 */

/**
 * On/off toggle.
 *
 * Contract:
 * - Calls onChange(!checked) on click; never fires while disabled.
 */
export function Switch({ label, checked, onChange, disabled = false }) {
    return (
        <button
            type="button"
            role="switch"
            className="switch"
            aria-label={label}
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        />
    )
}

/**
 * One-of-many picker shown as a row of buttons.
 *
 * Contract:
 * - options: [{ id, label, icon?, badge? }]; calls onChange(id) on click, including the active one.
 * - The active button carries the `active` class and aria-pressed="true".
 */
export function Segmented({ label, options, value, onChange, className = '' }) {
    return (
        <div role="group" aria-label={label} className={`segmented ${className}`}>
            {options.map(({ id, label: text, icon: Icon, badge }) => (
                <button
                    key={id}
                    type="button"
                    aria-pressed={value === id}
                    className={value === id ? 'active' : ''}
                    onClick={() => onChange(id)}
                >
                    {Icon && <Icon size={14} />}
                    <span>{text}</span>
                    {badge && <span className="segmented-badge">({badge})</span>}
                </button>
            ))}
        </div>
    )
}
