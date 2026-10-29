import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BookingModal from './BookingModal.jsx'
import './App.css'

const API = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001/api' : '')
if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  throw new Error('VITE_API_URL must point to the deployed appointment API when building for production.')
}

const formatDateKey = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const getBookingDays = (weekOffset = 0) => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() + weekOffset * 7)
  const lastBookableDate = new Date()
  lastBookableDate.setHours(0, 0, 0, 0)
  lastBookableDate.setDate(lastBookableDate.getDate() + 60)
  const lastBookableKey = formatDateKey(lastBookableDate)

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return { date, key: formatDateKey(date) }
  }).filter(({ key }) => key <= lastBookableKey)
}

const slotTimes = Array.from({ length: 41 }, (_, index) => {
  const minutes = 8 * 60 + index * 15
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

const prettyDate = (value, options = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(`${value}T12:00:00`).toLocaleDateString('en', options)

const clock = (value) => new Date(`2000-01-01T${value}`).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
const trackEvent = (event) => {
  void fetch(`${API}/analytics/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => {})
}

const OFFLINE_MESSAGE = 'Error 503: Service unavailable. The server is offline.'
const errorText = (error, fallback) =>
  error instanceof TypeError ? OFFLINE_MESSAGE : (error?.message || fallback)

const REQUIRED_MESSAGE = 'Please fill out this field'
const requiredProps = {
  required: true,
  onInvalid: (event) => {
    const el = event.target
    el.setCustomValidity(el.validity.valueMissing ? REQUIRED_MESSAGE : '')
  },
  onInput: (event) => event.target.setCustomValidity(''),
}

function Notice({ message, onClose }) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), 8000)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') closeRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="notice-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="notice-card" role="alertdialog" aria-live="assertive" aria-label="Notification">
        <button type="button" className="notice-close" autoFocus onClick={onClose} aria-label="Close notification">×</button>
        <p>{message}</p>
      </div>
    </div>
  )
}

function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

function BtnLabel({ loading, loadingText, children }) {
  return loading ? <span className="btn-loading"><Spinner />{loadingText}</span> : children
}

function SlowHint({ active }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setTimeout(() => setSlow(true), 4000)
    return () => {
      window.clearTimeout(timer)
      setSlow(false)
    }
  }, [active])
  if (!active) return null
  return (
    <div className="loading-hint" role="status">
      <Spinner size={14} />
      <span>{slow ? 'Still working — the server is waking up, this can take a few seconds…' : 'Just a moment…'}</span>
    </div>
  )
}

function SlotSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }, (_, index) => <div className="skeleton skeleton-slot" key={index} />)}
    </>
  )
}

function App() {
  const [auth, setAuth] = useState(() => {
    try {
      const stored = sessionStorage.getItem('office-hours-auth')
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    if (auth?.token) {
      sessionStorage.setItem('office-hours-auth', JSON.stringify(auth))
    } else {
      sessionStorage.removeItem('office-hours-auth')
    }
  }, [auth])

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (path === '/') trackEvent('booking_page_view')
  }, [path])

  const navigate = (nextPath) => {
    window.history.pushState({}, '', nextPath)
    setPath(nextPath)
  }

  if (path === '/lecturer-dashboard') {
    return <LecturerDashboard auth={auth} setAuth={setAuth} navigate={navigate} />
  }
  if (path === '/500') return <StatusPage code="500" navigate={navigate} />
  if (path === '/privacy') return <PolicyPage type="privacy" navigate={navigate} />
  if (path === '/terms') return <PolicyPage type="terms" navigate={navigate} />
  if (path !== '/') return <StatusPage code="404" navigate={navigate} />

  return <StudentPage auth={auth} setAuth={setAuth} navigate={navigate} />
}

export class ErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <main className="page-shell center-page">
        <section className="panel simple-panel status-card" role="alert">
          <div className="status-code">500</div>
          <div className="eyebrow">Something went wrong</div>
          <h1>We couldn’t load this page.</h1>
          <p>Please try again. If the problem continues, the booking service may be temporarily unavailable.</p>
          <a className="primary-button full-width status-link" href="/">Back to appointments</a>
        </section>
      </main>
    )
  }
}

function StatusPage({ code, navigate }) {
  const isNotFound = code === '404'
  return (
    <main className="page-shell center-page">
      <section className="panel simple-panel status-card" role="status">
        <div className="status-code">{isNotFound ? '404' : '500'}</div>
        <div className="eyebrow">{isNotFound ? 'Page not found' : 'Something went wrong'}</div>
        <h1>{isNotFound ? 'This page took a wrong turn.' : 'We couldn’t load this page.'}</h1>
        <p>{isNotFound ? 'The page may have moved, or the address may be incorrect.' : 'Please try again. If the problem continues, the booking service may be temporarily unavailable.'}</p>
        <button className="primary-button full-width" type="button" onClick={() => navigate('/')}>Back to appointments</button>
      </section>
    </main>
  )
}

function PolicyPage({ type, navigate }) {
  const isPrivacy = type === 'privacy'
  return (
    <main className="page-shell center-page policy-page">
      <article className="panel simple-panel policy-card">
        <div className="eyebrow">Appointment booking service</div>
        <h1>{isPrivacy ? 'Privacy policy' : 'Terms of use'}</h1>
        <p className="policy-updated">Last updated: October 9, 2026</p>
        {isPrivacy ? (
          <>
            <h2>Information collected</h2>
            <p>When you request an appointment, this service stores the name, email address, student number, level, department, appointment time, and optional reason you submit. Email verification codes are stored as salted hashes and expire after five minutes. Lecturer session tokens are stored as hashes.</p>
            <h2>How information is used</h2>
            <p>Information is used to verify your email, manage appointments and waitlists, and send appointment-related messages. Aggregate booking-funnel event counts are collected without names, email addresses, or IP addresses.</p>
            <h2>Storage and sharing</h2>
            <p>Booking data is held in the service’s SQLite database and is available to the lecturer managing appointments. Email content is processed by the configured email provider. Do not include sensitive or unnecessary information in the appointment reason.</p>
            <h2>Retention and requests</h2>
            <p>Expired analytics events are removed after 90 days. Appointment and waitlist records remain until they are removed or the database retention policy is applied. To request access, correction, or deletion, contact the lecturer who operates this service.</p>
            <h2>Security and contact</h2>
            <p>Reasonable technical safeguards are used, but no online system can guarantee absolute security. Contact the lecturer through the institution’s usual channel with privacy questions or concerns.</p>
          </>
        ) : (
          <>
            <h2>Using the service</h2>
            <p>Use accurate contact and student details, verify an email address you control, and submit appointment requests for legitimate academic purposes. Do not attempt to disrupt, overload, access, or misuse the service.</p>
            <h2>Appointments</h2>
            <p>A booking is confirmed only after the service accepts it. Availability can change before a booking is completed. A booking may be cancelled or changed by contacting the lecturer; email notifications are provided as a convenience.</p>
            <h2>Service availability</h2>
            <p>The service is provided for appointment coordination and may be interrupted for maintenance or technical issues. Do not rely on it for emergencies or urgent safety matters; contact the institution through its official urgent channels instead.</p>
            <h2>Contact and changes</h2>
            <p>Questions about appointments or these terms should be sent to the lecturer through the institution’s usual channel. These terms may be updated when the service or its operating requirements change.</p>
          </>
        )}
        <button className="link-button compact" type="button" onClick={() => navigate('/')}>Back to booking</button>
      </article>
    </main>
  )
}

const STUDENT_KEY = 'office-hours-student'
const EMPTY_FORM = { student: '', email: '', matricNo: '', level: '', department: '', topic: '' }
const EMPTY_OTP = { email: '', otp: '', sent: false, verified: false, sending: false, verifying: false }

const loadStudentSession = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STUDENT_KEY) || 'null')
    if (!saved || !saved.expiresAt || saved.expiresAt < Date.now()) {
      sessionStorage.removeItem(STUDENT_KEY)
      return null
    }
    return saved
  } catch {
    return null
  }
}

function StudentPage({ auth, setAuth, navigate }) {
  const [slots, setSlots] = useState([])
  const [stats, setStats] = useState({ total: 0, booked: 0, available: 0, nextBooking: null })
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0)
  const calendarDays = useMemo(() => getBookingDays(calendarWeekOffset), [calendarWeekOffset])
  const [selectedDay, setSelectedDay] = useState(() => getBookingDays()[0].key)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [restored] = useState(loadStudentSession)
  const [form, setForm] = useState(() => restored?.form || EMPTY_FORM)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [slotsLoading, setSlotsLoading] = useState(true)
  const [waitlistBusy, setWaitlistBusy] = useState(false)
  const [otpState, setOtpState] = useState(() => (restored?.otpState ? { ...EMPTY_OTP, ...restored.otpState } : EMPTY_OTP))
  const [verifiedUntil, setVerifiedUntil] = useState(() => restored?.expiresAt || 0)

  // Keep a verified student verified across page refreshes (until the server-side verification expires).
  useEffect(() => {
    try {
      if (otpState.verified && verifiedUntil > Date.now() && !confirmation) {
        sessionStorage.setItem(STUDENT_KEY, JSON.stringify({
          form,
          otpState: { email: otpState.email, otp: otpState.otp, sent: true, verified: true },
          expiresAt: verifiedUntil,
        }))
      } else {
        sessionStorage.removeItem(STUDENT_KEY)
      }
    } catch {
      /* storage unavailable: the page simply works without refresh persistence */
    }
  }, [form, otpState, verifiedUntil, confirmation])

  const refreshSlots = async () => {
    try {
      const response = await fetch(`${API}/slots`)
      if (!response.ok) throw new Error('Could not load appointments')
      setSlots(await response.json())
    } catch {
      setMessage(OFFLINE_MESSAGE)
    }
  }

  const refreshStats = async () => {
    try {
      const response = await fetch(`${API}/stats`)
      if (!response.ok) throw new Error('Could not fetch stats')
      setStats(await response.json())
    } catch {
      setStats((current) => current)
    }
  }

  useEffect(() => {
    let ignore = false

    const load = async () => {
      try {
        const [slotsRes, statsRes] = await Promise.all([
          fetch(`${API}/slots`),
          fetch(`${API}/stats`),
        ])

        if (!ignore) {
          if (slotsRes.ok) setSlots(await slotsRes.json())
          if (statsRes.ok) setStats(await statsRes.json())
        }
      } catch {
        if (!ignore) {
          setMessage(OFFLINE_MESSAGE)
        }
      } finally {
        if (!ignore) setSlotsLoading(false)
      }
    }

    void load()
    return () => {
      ignore = true
    }
  }, [])

  const daySlots = useMemo(
    () => slots.filter((slot) => slot.date === selectedDay).sort((a, b) => a.time.localeCompare(b.time)),
    [slots, selectedDay],
  )

  const handleSelectDay = (key) => {
    setSelectedDay(key)
    setSelectedSlot(null)
  }

  const changeCalendarWeek = (weekOffset) => {
    const nextDays = getBookingDays(weekOffset)
    if (!nextDays.length) return
    setCalendarWeekOffset(weekOffset)
    setSelectedDay(nextDays[0].key)
    setSelectedSlot(null)
  }

  const handleSelectSlot = (slot) => {
    if (!otpState.verified) {
      setMessage('Verify your email before choosing a slot.')
      return
    }

    setSelectedSlot(slot)
    trackEvent('slot_selected')
    setMessage('')
  }

  const requestOtp = async () => {
    const trimmedEmail = form.email.trim()
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setMessage('Enter a valid student email before requesting a code.')
      return
    }

    setOtpState((current) => ({ ...current, sending: true, verified: false }))
    trackEvent('otp_requested')

    try {
      const response = await fetch(`${API}/email/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, student: form.student.trim() }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not send verification code.')

      setOtpState({
        email: trimmedEmail,
        otp: '',
        sent: true,
        verified: false,
        sending: false,
        verifying: false,
      })

      setMessage(data.message || 'Verification email sent. Check your inbox and spam folder.')
    } catch (error) {
      setOtpState((current) => ({ ...current, sending: false }))
      setMessage(errorText(error, 'Unable to send verification code.'))
    }
  }

  const verifyOtp = async () => {
    if (!otpState.email || !otpState.otp.trim()) {
      setMessage('Enter the six-digit verification code.')
      return
    }

    setOtpState((current) => ({ ...current, verifying: true }))

    try {
      const response = await fetch(`${API}/email/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otpState.email, otp: otpState.otp }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'OTP verification failed.')

      setOtpState((current) => ({ ...current, verified: true, verifying: false }))
      setVerifiedUntil(data.verifiedUntil || Date.now() + 14 * 60 * 1000)
      trackEvent('email_verified')
      setMessage('Email verified successfully.')
    } catch (error) {
      setOtpState((current) => ({ ...current, verifying: false }))
      setMessage(errorText(error, 'Verification failed.'))
    }
  }

  const joinWaitlist = async (event) => {
    if (event) event.preventDefault()

    const trimmedName = form.student.trim()
    const trimmedEmail = form.email.trim()
    if (!trimmedName || !/^(?:\S+@\S+\.\S+)$/.test(trimmedEmail)) {
      setMessage('Enter your name and a valid email to join the waitlist.')
      return
    }

    if (!otpState.verified || otpState.email !== trimmedEmail.toLowerCase()) {
      setMessage('Verify your email before joining the waitlist.')
      return
    }

    setWaitlistBusy(true)
    try {
      const response = await fetch(`${API}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedDay,
          student: trimmedName,
          email: trimmedEmail,
          topic: form.topic,
          urgency: 'urgent',
          otp: otpState.otp,
        }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not add you to the waitlist.')

      setOtpState(EMPTY_OTP)
      setVerifiedUntil(0)
      setMessage('You have been added to the waitlist for this day.')
    } catch (error) {
      setMessage(errorText(error, 'We could not add you to the waitlist.'))
    } finally {
      setWaitlistBusy(false)
    }
  }

  const bookSlot = async (event) => {
    event.preventDefault()

    if (!otpState.verified || otpState.email !== form.email.trim().toLowerCase()) {
      setMessage('Verify your email before confirming the appointment.')
      return
    }

    if (!selectedSlot) {
      setMessage('Please select a time before booking.')
      return
    }

    if (!form.topic.trim()) {
      setMessage('Please tell us the reason for your appointment.')
      return
    }

    setBusy(true)

    try {
      const response = await fetch(`${API}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: selectedSlot.id, ...form, otp: otpState.otp }),
      })

      const data = await response.json()
      if (response.status === 401) {
        // Verification expired: send the student back to verify again.
        setSelectedSlot(null)
        setOtpState(EMPTY_OTP)
        setVerifiedUntil(0)
      }
      if (!response.ok) throw new Error(data.error)

      const booking = data.confirmation || {
        student: form.student.trim(),
        email: form.email.trim(),
        matricNo: form.matricNo.trim(),
        level: form.level.trim(),
        department: form.department.trim(),
        date: selectedSlot.date,
        time: selectedSlot.time,
        topic: form.topic.trim() || 'No topic provided',
      }

      setSelectedSlot(null)
      trackEvent('booking_confirmed')
      setForm(EMPTY_FORM)
      setOtpState(EMPTY_OTP)
      setVerifiedUntil(0)
      setConfirmation({
        ...booking,
        studentConfirmationSent: data.emailDelivery?.studentConfirmation === true,
      })
      setMessage('Your appointment is confirmed.')
      await refreshSlots()
      await refreshStats()
    } catch (error) {
      setMessage(errorText(error, 'Booking failed.'))
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    if (auth?.token) {
      await fetch(`${API}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
      })
    }

    setAuth(null)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">C</div>
          <div>
            <div className="eyebrow">Book An Appointment </div>
            <strong>With Mrs Charity</strong>
          </div>
        </div>

        <div className="header-actions">
          {auth?.token && <button className="ghost-button" type="button" onClick={handleLogout}>Log out</button>}
        </div>
      </header>

      <main className="page-wrap auth-layout">
        {confirmation ? (
          <section className="login-card confirm-card">
            <div className="eyebrow">Appointment confirmed</div>
            <h1>Thank you</h1>
            <p className="helper-text">
              {confirmation.studentConfirmationSent
                ? `A confirmation email has been sent to ${confirmation.email}.`
                : `Your appointment is confirmed, but we could not send a confirmation email to ${confirmation.email}. Please save the appointment details below.`}
            </p>

            <div className="confirmation-summary">
              <div><span>Student</span><strong>{confirmation.student}</strong></div>
              <div><span>Matric number</span><strong>{confirmation.matricNo}</strong></div>
              <div><span>Level</span><strong>{confirmation.level}</strong></div>
              <div><span>Department</span><strong>{confirmation.department}</strong></div>
              <div><span>Date</span><strong>{prettyDate(confirmation.date, { weekday: 'long', month: 'long', day: 'numeric' })}</strong></div>
              <div><span>Time</span><strong>{clock(confirmation.time)}</strong></div>
              <div><span>Reason</span><strong>{confirmation.topic}</strong></div>
            </div>

            <button className="primary-button full-width" type="button" onClick={() => setConfirmation(null)}>Book another appointment</button>
          </section>
        ) : !otpState.verified ? (
          <section className="login-card">
            <div className="eyebrow">Office Hours</div>
            <h1>Student Access</h1>
            <p className="helper-text">Enter your details and verify your email before selecting a date and reason.</p>
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault()
                void requestOtp()
              }}
            >
              <label htmlFor="student-name">
                Full name
                <input id="student-name" aria-label="Full name" autoComplete="name" value={form.student} onChange={(event) => setForm({ ...form, student: event.target.value })} placeholder="Your name" {...requiredProps} />
              </label>

              <label htmlFor="student-matric-number">
                Matric number
                <input id="student-matric-number" aria-label="Matric number" value={form.matricNo} onChange={(event) => setForm({ ...form, matricNo: event.target.value })} placeholder="e.g. 24/1234" {...requiredProps} />
              </label>

              <div className="row-two">
                <label htmlFor="student-level">
                  Level
                  <input id="student-level" aria-label="Level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })} placeholder="e.g. 300 level" {...requiredProps} />
                </label>
                <label htmlFor="student-department">
                  Department
                  <input id="student-department" aria-label="Department" value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} placeholder="Your department" {...requiredProps} />
                </label>
              </div>

              <label htmlFor="student-email">
                Email
                <input id="student-email" aria-label="Student email" type="email" autoComplete="email" value={form.email} onChange={(event) => {
                  const nextEmail = event.target.value
                  setForm({ ...form, email: nextEmail })
                  if (otpState.email !== nextEmail.trim().toLowerCase()) {
                    setOtpState((current) => ({ ...current, sent: false, verified: false, otp: '' }))
                  }
                }} placeholder="name@email.com" {...requiredProps} />
              </label>

              <button type="submit" className={`secondary-button full-width ${otpState.sending ? 'is-loading' : ''}`} disabled={otpState.sending} aria-busy={otpState.sending}>
                <BtnLabel loading={otpState.sending} loadingText="Sending code…">{otpState.sent ? 'Resend OTP' : 'Send OTP'}</BtnLabel>
              </button>
              <SlowHint active={otpState.sending} />
            </form>

            {otpState.sent && (
              <form
                className="form-stack otp-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void verifyOtp()
                }}
              >
                <label htmlFor="student-otp">
                  Enter OTP
                  <input id="student-otp" aria-label="One-time password" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" title="Enter the 6-digit code" value={otpState.otp} maxLength={6} onChange={(event) =>
                    setOtpState((current) => ({
                      ...current,
                      otp: event.target.value.replace(/\D/g, '').slice(0, 6),
                    }))
                  } placeholder="123456" {...requiredProps} />
                </label>
                <button type="submit" className={`secondary-button full-width ${otpState.verifying ? 'is-loading' : ''}`} disabled={otpState.verifying} aria-busy={otpState.verifying}>
                  <BtnLabel loading={otpState.verifying} loadingText="Verifying…">Verify OTP</BtnLabel>
                </button>
              </form>
            )}
          </section>
        ) : null}

        {otpState.verified && !confirmation && (
          <section className="calendar-panel">
            <div className="panel-header">
              <h2>Available times</h2>
              <span>{stats.available || slots.filter((slot) => slot.status === 'available').length} open</span>
            </div>

            <label htmlFor="student-topic" className="booking-reason-label">
              Reason for appointment
              <textarea id="student-topic" aria-label="Reason for appointment" rows="3" value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} placeholder="Briefly explain your reason" />
            </label>

            <div className="calendar-navigation">
              <button className="secondary-button" type="button" disabled={calendarWeekOffset === 0} onClick={() => changeCalendarWeek(calendarWeekOffset - 1)}>Previous week</button>
              <span>{prettyDate(calendarDays[0].key, { month: 'short', day: 'numeric' })} – {prettyDate(calendarDays[calendarDays.length - 1].key, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <button className="secondary-button" type="button" disabled={calendarWeekOffset >= 8 || calendarDays.length < 7} onClick={() => changeCalendarWeek(calendarWeekOffset + 1)}>Next week</button>
            </div>

            <div className="day-row">
              {calendarDays.map(({ date, key }) => (
                <button key={key} type="button" className={`day-pill ${selectedDay === key ? 'active' : ''}`} onClick={() => handleSelectDay(key)}>
                  <span>{date.toLocaleDateString('en', { weekday: 'short' })}</span>
                  <strong>{date.getDate()}</strong>
                </button>
              ))}
            </div>

            <div className="selected-date-line">
              <strong>{prettyDate(selectedDay, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
              <small>{daySlots.filter((slot) => slot.status === 'available').length} slots left</small>
            </div>

            <div className="time-grid">
              {slotsLoading ? (
                <SlotSkeleton />
              ) : daySlots.filter((slot) => slot.status === 'available').length ? (
                daySlots.filter((slot) => slot.status === 'available').map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    className={`time-slot ${selectedSlot?.id === slot.id ? 'selected' : ''}`}
                    onClick={() => handleSelectSlot(slot)}
                  >
                    {clock(slot.time)}
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>No times left for this day.</strong>
                  <small>Use the waitlist if your issue is urgent.</small>
                  <button className={`secondary-button full-width ${waitlistBusy ? 'is-loading' : ''}`} type="button" onClick={joinWaitlist} disabled={waitlistBusy}>
                    <BtnLabel loading={waitlistBusy} loadingText="Joining…">Join waitlist</BtnLabel>
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="student-footer">
        <a href="/privacy" onClick={(event) => { event.preventDefault(); navigate('/privacy') }}>Privacy policy</a>
        <span aria-hidden="true">·</span>
        <a href="/terms" onClick={(event) => { event.preventDefault(); navigate('/terms') }}>Terms of use</a>
      </footer>

      {selectedSlot && (
        <BookingModal
          slot={selectedSlot}
          busy={busy}
          waitlistBusy={waitlistBusy}
          topic={form.topic}
          setTopic={(topic) => setForm((current) => ({ ...current, topic }))}
          onClose={() => setSelectedSlot(null)}
          onBook={bookSlot}
          onWaitlist={joinWaitlist}
        />
      )}

      {message && (
<Notice message={message} onClose={() => setMessage('')} />
      )}
    </div>
  )
}

function LecturerAccess({ onAuthenticated, navigate }) {
  const [mode, setMode] = useState('loading') // loading | login | request | reset
  const [hasPassword, setHasPassword] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let ignore = false
    const loadStatus = async () => {
      try {
        const response = await fetch(`${API}/lecturer/status`)
        const data = await response.json()
        if (ignore) return
        setHasPassword(Boolean(data.hasPassword))
        setMode(data.hasPassword ? 'login' : 'request')
      } catch {
        if (ignore) return
        setMode('login')
        setMessage(OFFLINE_MESSAGE)
      }
    }
    void loadStatus()
    return () => { ignore = true }
  }, [])

  const post = async (path, body) => {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    return { response, data }
  }

  const handleLogin = async (event) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')

    try {
      const { response, data } = await post('/login', { email, password })
      if (data.setupRequired) {
        setHasPassword(false)
        setMode('request')
      }
      if (!response.ok) throw new Error(data.error || 'Login failed')
      onAuthenticated({ token: data.token, lecturer: data.lecturer })
    } catch (error) {
      setMessage(errorText(error, 'Unable to sign in.'))
    } finally {
      setBusy(false)
    }
  }

  const handleRequestCode = async (event) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')

    try {
      const { response, data } = await post('/lecturer/password/request-code', { email })
      if (!response.ok) throw new Error(data.error || 'Could not send the verification code.')
      setCode('')
      setMode('reset')
      setMessage(data.message || 'Verification code sent.')
    } catch (error) {
      setMessage(errorText(error, 'Could not send the verification code.'))
    } finally {
      setBusy(false)
    }
  }

  const handleSetPassword = async (event) => {
    event.preventDefault()
    if (newPassword !== confirmPassword) {
      setMessage('The two passwords do not match.')
      return
    }

    setBusy(true)
    setMessage('')

    try {
      const { response, data } = await post('/lecturer/password/set', { email, code, password: newPassword })
      if (!response.ok) throw new Error(data.error || 'Could not save your password.')
      setHasPassword(true)
      setPassword('')
      setCode('')
      setNewPassword('')
      setConfirmPassword('')
      setMode('login')
      setMessage(data.message || 'Your password has been saved. You can now sign in.')
    } catch (error) {
      setMessage(errorText(error, 'Could not save your password.'))
    } finally {
      setBusy(false)
    }
  }

  const isSetup = !hasPassword
  const titles = {
    loading: ['Lecturer access', 'One moment…'],
    login: ['Lecturer access', 'Sign in'],
    request: isSetup ? ['First time here', 'Create your password'] : ['Forgot password', 'Reset your password'],
    reset: isSetup ? ['First time here', 'Create your password'] : ['Forgot password', 'Reset your password'],
  }
  const [eyebrow, heading] = titles[mode]

  const submitLabel = (loading, loadingText, text) => (
    <BtnLabel loading={loading} loadingText={loadingText}>{text}</BtnLabel>
  )

  return (
    <div className="page-shell center-page">
      <div className="panel simple-panel">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{heading}</h1>

        {mode === 'loading' && <div className="loading-hint" role="status"><Spinner size={14} /><span>Checking your account…</span></div>}

        {mode === 'login' && (
          <>
            <p>Sign in with the lecturer account to manage bookings, waitlist requests, and appointment slots.</p>
            <form onSubmit={handleLogin} className="form-block">
              <label htmlFor="lecturer-email">
                Email
                <input id="lecturer-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} {...requiredProps} />
              </label>
              <label htmlFor="lecturer-password">
                Password
                <input id="lecturer-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} {...requiredProps} />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />
                Show password
              </label>
              <button className={`primary-button full-width ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
                {submitLabel(busy, 'Signing in…', 'Sign in')}
              </button>
              <SlowHint active={busy} />
            </form>
            <button className="link-button compact" type="button" onClick={() => { setMessage(''); setMode('request') }}>Forgot password?</button>
          </>
        )}

        {mode === 'request' && (
          <>
            <p>
              {isSetup
                ? 'Enter your lecturer email. We will send a verification code to it so you can create your own password.'
                : 'Enter your lecturer email. We will send a verification code to it so you can choose a new password.'}
            </p>
            <form onSubmit={handleRequestCode} className="form-block">
              <label htmlFor="lecturer-reset-email">
                Email
                <input id="lecturer-reset-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} {...requiredProps} />
              </label>
              <button className={`primary-button full-width ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
                {submitLabel(busy, 'Sending code…', 'Send verification code')}
              </button>
              <SlowHint active={busy} />
            </form>
            {hasPassword && <button className="link-button compact" type="button" onClick={() => { setMessage(''); setMode('login') }}>Back to sign in</button>}
          </>
        )}

        {mode === 'reset' && (
          <>
            <p>Enter the 6-digit code we emailed to {email}, then choose your password.</p>
            <form onSubmit={handleSetPassword} className="form-block">
              <label htmlFor="lecturer-code">
                Verification code
                <input id="lecturer-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" title="Enter the 6-digit code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" {...requiredProps} />
              </label>
              <label htmlFor="lecturer-new-password">
                New password
                <input id="lecturer-new-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 10 characters, with a number" {...requiredProps} />
              </label>
              <label htmlFor="lecturer-confirm-password">
                Confirm password
                <input id="lecturer-confirm-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} {...requiredProps} />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />
                Show passwords
              </label>
              <button className={`primary-button full-width ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
                {submitLabel(busy, 'Saving…', 'Save password')}
              </button>
            </form>
            <button className="link-button compact" type="button" onClick={() => { setMessage(''); setMode('request') }}>Send a new code</button>
          </>
        )}

        {message && <Notice message={message} onClose={() => setMessage('')} />}
        <button className="link-button compact" type="button" onClick={() => navigate('/')}>Back to booking page</button>
      </div>
    </div>
  )
}

function LecturerDashboard({ auth, setAuth, navigate }) {
  const [slots, setSlots] = useState([])
  const [bookings, setBookings] = useState([])
  const [history, setHistory] = useState([])
  const [waitlist, setWaitlist] = useState([])
  const [analytics, setAnalytics] = useState({ total: 0, booked: 0, available: 0, todayAppointments: 0, waitlistCount: 0, upcoming: [], funnel: {} })
  const [stats, setStats] = useState({ total: 0, booked: 0, available: 0, nextBooking: null })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [noticeBusy, setNoticeBusy] = useState('')
  const [dashLoading, setDashLoading] = useState(true)
  const [newSlot, setNewSlot] = useState({ date: getBookingDays()[0].key, time: '', duration: '30', isEmergency: false })

  const handleUnauthorized = useCallback((response) => {
    if (response.status !== 401) return false
    setAuth(null)
    setMessage('Your lecturer session expired. Please sign in again.')
    return true
  }, [setAuth])

  const refreshDashboard = useCallback(async () => {
    if (!auth?.token) return

    try {
      const [slotsRes, bookingsRes, waitlistRes, statsRes, analyticsRes, historyRes] = await Promise.all([
        fetch(`${API}/slots/manage`, { headers: { Authorization: `Bearer ${auth.token}` } }),
        fetch(`${API}/bookings`, { headers: { Authorization: `Bearer ${auth.token}` } }),
        fetch(`${API}/waitlist`, { headers: { Authorization: `Bearer ${auth.token}` } }),
        fetch(`${API}/stats`),
        fetch(`${API}/analytics`, { headers: { Authorization: `Bearer ${auth.token}` } }),
        fetch(`${API}/bookings/history`, { headers: { Authorization: `Bearer ${auth.token}` } }),
      ])

      if ([slotsRes, bookingsRes, waitlistRes, analyticsRes, historyRes].some((response) => handleUnauthorized(response))) return

      if (slotsRes.ok) setSlots(await slotsRes.json())
      if (bookingsRes.ok) setBookings(await bookingsRes.json())
      if (waitlistRes.ok) setWaitlist(await waitlistRes.json())
      if (statsRes.ok) setStats(await statsRes.json())
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json())
      if (historyRes.ok) setHistory(await historyRes.json())
    } catch {
      setMessage('Could not refresh lecturer data.')
    } finally {
      setDashLoading(false)
    }
  }, [auth, handleUnauthorized])

  useEffect(() => {
    if (!auth?.token) return undefined
    const refreshTimeout = window.setTimeout(() => {
      void refreshDashboard()
    }, 0)
    return () => window.clearTimeout(refreshTimeout)
  }, [auth, refreshDashboard])

  const handleLogout = async () => {
    if (auth?.token) {
      await fetch(`${API}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
      })
    }

    setAuth(null)
    setBookings([])
    setWaitlist([])
  }

  const addSlot = async (event) => {
    event.preventDefault()

    if (!auth?.token) {
      setMessage('Please sign in first.')
      return
    }

    const duplicateSlot = slots.find((slot) => slot.date === newSlot.date && slot.time === newSlot.time)
    if (duplicateSlot) {
      setMessage(`A ${duplicateSlot.status} slot already exists on ${prettyDate(newSlot.date, { weekday: 'long', month: 'long', day: 'numeric' })} at ${clock(newSlot.time)}. Choose another time.`)
      return
    }

    setBusy(true)

    try {
      const response = await fetch(`${API}/slots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify(newSlot),
      })

      if (handleUnauthorized(response)) return
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not add slot.')

      setMessage(newSlot.isEmergency ? 'Emergency slot added.' : 'Slot added.')
      setNewSlot((current) => ({ ...current, time: '', isEmergency: false }))

      const slotsRes = await fetch(`${API}/slots/manage`, { headers: { Authorization: `Bearer ${auth.token}` } })
      if (slotsRes.ok) setSlots(await slotsRes.json())
      await refreshDashboard()
    } catch (error) {
      setMessage(errorText(error, 'Could not add slot.'))
    } finally {
      setBusy(false)
    }
  }

  const removeBooking = async (slotId) => {
    if (!auth?.token) return

    try {
      const response = await fetch(`${API}/bookings/${slotId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      })

      if (handleUnauthorized(response)) return
      if (!response.ok) throw new Error('Could not cancel booking.')

      setMessage('Booking cancelled.')
      await refreshDashboard()

      const slotsRes = await fetch(`${API}/slots/manage`, { headers: { Authorization: `Bearer ${auth.token}` } })
      if (slotsRes.ok) setSlots(await slotsRes.json())
    } catch (error) {
      setMessage(errorText(error, 'Could not cancel booking.'))
    }
  }

  const removeAvailableSlot = async (slotId) => {
    if (!auth?.token) return

    try {
      const response = await fetch(`${API}/slots/${slotId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (handleUnauthorized(response)) return
      const data = response.status === 204 ? null : await response.json()
      if (!response.ok) throw new Error(data?.error || 'Could not remove slot.')

      setMessage('Available slot removed.')
      const slotsRes = await fetch(`${API}/slots/manage`, { headers: { Authorization: `Bearer ${auth.token}` } })
      if (slotsRes.ok) setSlots(await slotsRes.json())
      await refreshDashboard()
    } catch (error) {
      setMessage(errorText(error, 'Could not remove slot.'))
    }
  }

  const removeWaitlist = async (id) => {
    if (!auth?.token) return

    try {
      const response = await fetch(`${API}/waitlist/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      })

      if (handleUnauthorized(response)) return
      if (!response.ok) throw new Error('Could not remove waitlist request.')

      setWaitlist((current) => current.filter((item) => item.id !== id))
      setMessage('Waitlist request removed.')
    } catch (error) {
      setMessage(errorText(error, 'Could not remove waitlist request.'))
    }
  }

  const sendAttendanceNotice = async (recipientType, recipientId, shouldAttend) => {
    if (!auth?.token) return
    const requestKey = `${recipientType}:${recipientId}:${shouldAttend}`
    setNoticeBusy(requestKey)

    try {
      const response = await fetch(`${API}/attendance-notices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ recipientType, recipientId, shouldAttend }),
      })
      if (handleUnauthorized(response)) return
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not send the email.')
      setMessage(data.message || 'Email sent.')
    } catch (error) {
      setMessage(errorText(error, 'Could not send the email.'))
    } finally {
      setNoticeBusy('')
    }
  }

  const availableCount = slots.filter((slot) => slot.status === 'available').length

  if (!auth?.token) {
    return <LecturerAccess onAuthenticated={setAuth} navigate={navigate} />
  }

  return (
    <div className="page-shell">
      {dashLoading && <div className="top-loader" role="progressbar" aria-label="Loading dashboard" />}
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">O</div>
          <div>
            <div className="eyebrow">Lecturer</div>
            <strong>Dashboard</strong>
          </div>
        </div>

        <div className="header-actions">
          <button className="link-button" type="button" onClick={() => navigate('/')}>Student view</button>
          <button className="ghost-button" type="button" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <main className="page-wrap dashboard-page">
        <section className="panel stats-panel">
          <div className="panel-header">
            <h2>Overview</h2>
            <span>{stats.booked || bookings.length} booked</span>
          </div>

          <div className="stats-grid">
            <div className="stat-box">
              <small>Available</small>
              <strong>{stats.available || availableCount}</strong>
            </div>
            <div className="stat-box">
              <small>Booked</small>
              <strong>{stats.booked || bookings.length}</strong>
            </div>
            <div className="stat-box">
              <small>Waitlist</small>
              <strong>{analytics.waitlistCount || waitlist.length}</strong>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Analytics</h2>
          </div>

          <div className="stats-grid">
            <div className="stat-box">
              <small>Total slots</small>
              <strong>{analytics.total || stats.total || slots.length}</strong>
            </div>
            <div className="stat-box">
              <small>Today</small>
              <strong>{analytics.todayAppointments || 0}</strong>
            </div>
            <div className="stat-box">
              <small>Upcoming</small>
              <strong>{analytics.upcoming?.length || 0}</strong>
            </div>
          </div>
          <div className="funnel-grid" aria-label="Anonymous booking funnel totals">
            <div><small>Booking page views</small><strong>{analytics.funnel?.booking_page_view || 0}</strong></div>
            <div><small>OTP requests</small><strong>{analytics.funnel?.otp_requested || 0}</strong></div>
            <div><small>Emails verified</small><strong>{analytics.funnel?.email_verified || 0}</strong></div>
            <div><small>Times selected</small><strong>{analytics.funnel?.slot_selected || 0}</strong></div>
            <div><small>Bookings completed</small><strong>{analytics.funnel?.booking_confirmed || 0}</strong></div>
          </div>
          <p className="analytics-note">Aggregate counts only; no names, email addresses, or IP addresses are stored.</p>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Add a slot</h2>
          </div>

          <form onSubmit={addSlot} className="form-block">
            <div className="row-two">
              <label htmlFor="slot-date">
                Date
                <input id="slot-date" aria-label="Appointment date" type="date" min={formatDateKey(new Date())} value={newSlot.date} onChange={(event) => setNewSlot({ ...newSlot, date: event.target.value })} {...requiredProps} />
              </label>
              <label htmlFor="slot-time">
                Time
                <select id="slot-time" aria-label="Appointment time" value={newSlot.time} onChange={(event) => setNewSlot({ ...newSlot, time: event.target.value })} {...requiredProps}>
                  <option value="">Select a time</option>
                  {slotTimes.map((time) => <option key={time} value={time}>{clock(time)}</option>)}
                </select>
              </label>
            </div>

            <div className="row-two">
              <label htmlFor="slot-duration">
                Duration
                <select id="slot-duration" aria-label="Appointment duration" value={newSlot.duration} onChange={(event) => setNewSlot({ ...newSlot, duration: event.target.value })}>
                  <option value="30">30 minutes</option>
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={newSlot.isEmergency} aria-label="Emergency slot" onChange={(event) => setNewSlot({ ...newSlot, isEmergency: event.target.checked })} />
                Same-day emergency slot
              </label>
            </div>

            <button className={`primary-button full-width ${busy ? 'is-loading' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
              <BtnLabel loading={busy} loadingText="Saving…">Add time</BtnLabel>
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Scheduled slots</h2>
            <span>{slots.length} total</span>
          </div>

          {slots.length ? (
            <div className="list-stack">
              {[...slots].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).map((slot) => (
                <div className="list-item" key={slot.id}>
                  <div>
                    <strong>{prettyDate(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })} · {clock(slot.time)}</strong>
                    <small>{slot.status === 'booked' ? `Booked by ${slot.student || 'a student'}` : 'Available'}</small>
                  </div>
                  {slot.status === 'available' && (
                    <button className="ghost-button" type="button" onClick={() => removeAvailableSlot(slot.id)}>Remove slot</button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-list">No slots scheduled yet.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Appointments</h2>
          </div>

          {bookings.length ? (
            <div className="list-stack">
              {bookings.map((slot) => (
                <div className="list-item" key={slot.id}>
                  <div>
                    <strong>{slot.student}</strong>
                    <small>{slot.email}</small>
                    {slot.matric_no && <small>Matric: {slot.matric_no}</small>}
                    {(slot.level || slot.department) && <small>{[slot.level, slot.department].filter(Boolean).join(' · ')}</small>}
                    <small>{slot.topic || 'No topic provided'}</small>
                  </div>
                  <div className="meta-block">
                    <strong>{prettyDate(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                    <small>{clock(slot.time)}</small>
                  </div>
                  <div className="attendance-actions">
                    <button className="ghost-button" type="button" disabled={noticeBusy !== ''} onClick={() => sendAttendanceNotice('booking', slot.id, true)}>
                      <BtnLabel loading={noticeBusy === `booking:${slot.id}:true`} loadingText="Sending…">Tell to come</BtnLabel>
                    </button>
                    <button className="ghost-button" type="button" disabled={noticeBusy !== ''} onClick={() => sendAttendanceNotice('booking', slot.id, false)}>
                      <BtnLabel loading={noticeBusy === `booking:${slot.id}:false`} loadingText="Sending…">Tell not to come</BtnLabel>
                    </button>
                    <button className="ghost-button" type="button" onClick={() => removeBooking(slot.id)}>Cancel</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-list">No appointments booked yet.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Recent history</h2>
          </div>

          {history.length ? (
            <div className="list-stack">
              {history.slice(0, 5).map((slot) => (
                <div className="list-item" key={`${slot.id}-history`}>
                  <div>
                    <strong>{slot.student}</strong>
                    {slot.matric_no && <small>Matric: {slot.matric_no}</small>}
                    {(slot.level || slot.department) && <small>{[slot.level, slot.department].filter(Boolean).join(' · ')}</small>}
                    <small>{slot.topic || 'No topic provided'}</small>
                  </div>
                  <div className="meta-block">
                    <strong>{prettyDate(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                    <small>{clock(slot.time)}</small>
                  </div>
                  <span className="history-tag">Booked</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-list">No appointment history yet.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Waitlist</h2>
          </div>

          {waitlist.length ? (
            <div className="list-stack">
              {waitlist.map((entry) => (
                <div className="list-item" key={entry.id}>
                  <div>
                    <strong>{entry.student}</strong>
                    <small>{entry.email}</small>
                    <small>{entry.urgency === 'urgent' ? 'Urgent' : 'Standard'}</small>
                  </div>
                  <div className="meta-block">
                    <strong>{prettyDate(entry.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                  </div>
                  <div className="attendance-actions">
                    <button className="ghost-button" type="button" disabled={noticeBusy !== ''} onClick={() => sendAttendanceNotice('waitlist', entry.id, true)}>
                      <BtnLabel loading={noticeBusy === `waitlist:${entry.id}:true`} loadingText="Sending…">Tell to come</BtnLabel>
                    </button>
                    <button className="ghost-button" type="button" disabled={noticeBusy !== ''} onClick={() => sendAttendanceNotice('waitlist', entry.id, false)}>
                      <BtnLabel loading={noticeBusy === `waitlist:${entry.id}:false`} loadingText="Sending…">Tell not to come</BtnLabel>
                    </button>
                    <button className="ghost-button" type="button" onClick={() => removeWaitlist(entry.id)}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-list">No students waiting right now.</div>
          )}
        </section>
      </main>

      {message && (
<Notice message={message} onClose={() => setMessage('')} />
      )}
    </div>
  )
}

export default App
