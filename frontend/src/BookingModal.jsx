import { useEffect, useRef } from 'react'

const Spinner = () => <span className="spinner" aria-hidden="true" />

const prettyDate = (value) =>
  new Date(`${value}T12:00:00`).toLocaleDateString('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

const clock = (value) =>
  new Date(`2000-01-01T${value}`).toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
  })

export default function BookingModal({ slot, busy, waitlistBusy, topic, setTopic, onClose, onBook, onWaitlist }) {
  const modalRef = useRef(null)
  const closeButtonRef = useRef(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previousFocus = document.activeElement
    const modal = modalRef.current
    closeButtonRef.current?.focus()

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab' || !modal) return
      const focusable = [...modal.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
      if (!focusable.length) {
        event.preventDefault()
        modal.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        className="booking-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-modal-title"
        aria-describedby="booking-modal-details"
        tabIndex={-1}
      >
        <button ref={closeButtonRef} className="close-button" type="button" onClick={onClose} aria-label="Close booking dialog">×</button>
        <div className="eyebrow">Appointment request</div>
        <h2 id="booking-modal-title">{prettyDate(slot.date)}</h2>
        <p id="booking-modal-details">{clock(slot.time)} · {slot.duration || 30} minutes</p>

        <form onSubmit={onBook} className="form-block">
          <label htmlFor="booking-modal-topic">
            Reason for appointment
            <textarea
              id="booking-modal-topic"
              rows="3"
              value={topic}
              required
              onChange={(event) => setTopic(event.target.value)}
              onInvalid={(event) => event.target.setCustomValidity('Please fill out this field')}
              onInput={(event) => event.target.setCustomValidity('')}
            />
          </label>

          <button className={`primary-button full-width ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy || waitlistBusy} aria-busy={busy}>
            {busy ? <span className="btn-loading"><Spinner />Confirming…</span> : 'Confirm appointment'}
          </button>

          <button type="button" className={`secondary-button full-width ${waitlistBusy ? 'is-loading' : ''}`} onClick={onWaitlist} disabled={busy || waitlistBusy}>
            {waitlistBusy ? <span className="btn-loading"><Spinner />Joining…</span> : 'Join waitlist instead'}
          </button>
        </form>
      </div>
    </div>
  )
}
