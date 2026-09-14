import { Minus, Plus } from 'lucide-react'

export default function ZoomControl({ zoom, increase, decrease, reset }) {
    return (
        <div className="zoom-control" aria-label="Text size">
            <button type="button" onClick={decrease} aria-label="Decrease zoom" title="Decrease text size">
                <Minus size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={reset} aria-label="Reset zoom" title="Reset text size">
                {zoom}%
            </button>
            <button type="button" onClick={increase} aria-label="Increase zoom" title="Increase text size">
                <Plus size={16} aria-hidden="true" />
            </button>
        </div>
    )
}
