import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import Database from 'better-sqlite3'
import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import cron from 'node-cron'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })

const app = express()
const port = Number(process.env.PORT || 3001)
const OTP_TTL_MS = 5 * 60 * 1000
const VERIFIED_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const appointmentTimeZone = process.env.APPOINTMENT_TIME_ZONE || 'UTC'
try {
  new Intl.DateTimeFormat('en-US', { timeZone: appointmentTimeZone })
} catch {
  throw new Error('APPOINTMENTb _TIME_ZONE must be a valid IANA timezone, such as Europe/London.')
}
process.env.TZ = appointmentTimeZone
const databaseFile = process.env.APPOINTMENTS_DB_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../appointments.db')
const LECTURER = {
  name: 'Mrs Charity',
  email: process.env.LECTURER_EMAIL || '',
}

if (process.env.NODE_ENV === 'production') {
  const missingSettings = [
    ['LECTURER_EMAIL', LECTURER.email],
    ['SMTP_HOST', process.env.SMTP_HOST],
    ['SMTP_USER', process.env.SMTP_USER],
    ['SMTP_PASS', process.env.SMTP_PASS],
    ['FRONTEND_ORIGIN', process.env.FRONTEND_ORIGIN],
    ['APPOINTMENTS_DB_PATH', process.env.APPOINTMENTS_DB_PATH],
    ['APPOINTMENT_TIME_ZONE', process.env.APPOINTMENT_TIME_ZONE],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missingSettings.length) {
    throw new Error(`Missing required production environment settings: ${missingSettings.join(', ')}`)
  }
  if (!/^\S+@\S+\.\S+$/.test(LECTURER.email)) {
    throw new Error('LECTURER_EMAIL must be a valid email address in production.')
  }
  if (!path.isAbsolute(databaseFile)) {
    throw new Error('APPOINTMENTS_DB_PATH must be an absolute path to persistent storage in production.')
  }
  const frontendOrigins = process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  if (!frontendOrigins.length || frontendOrigins.some((origin) => {
    try {
      return new URL(origin).protocol !== 'https:'
    } catch {
      return true
    }
  })) {
    throw new Error('FRONTEND_ORIGIN must contain comma-separated HTTPS origins in production.')
  }
  const smtpPort = Number(process.env.SMTP_PORT || 587)
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error('SMTP_PORT must be a valid TCP port in production.')
  }
}

const db = new Database(databaseFile)

function validateDateString(dateString) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return { valid: false, error: 'Choose a valid date.' }
  }

  const selectedDate = new Date(`${dateString}T00:00:00Z`)
  if (Number.isNaN(selectedDate.getTime()) || selectedDate.toISOString().slice(0, 10) !== dateString) {
    return { valid: false, error: 'Choose a valid date.' }
  }

  const today = getLocalDateKey()
  if (dateString < today) {
    return { valid: false, error: 'Appointments cannot be scheduled for past dates.' }
  }

  const maxFutureDate = new Date(`${today}T00:00:00Z`)
  maxFutureDate.setUTCDate(maxFutureDate.getUTCDate() + 60)
  if (dateString > maxFutureDate.toISOString().slice(0, 10)) {
    return { valid: false, error: 'Appointments can only be booked up to 60 days ahead.' }
  }

  return { valid: true }
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function validateTimeString(timeString) {
  if (typeof timeString !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeString)) {
    return { valid: false, error: 'Choose a valid time.' }
  }

  const [hours, minutes] = timeString.split(':').map(Number)
  const totalMinutes = hours * 60 + minutes
  if (minutes % 15 !== 0) {
    return { valid: false, error: 'Appointments must be scheduled in 15-minute blocks.' }
  }

  if (totalMinutes < 8 * 60 || totalMinutes > 18 * 60) {
    return { valid: false, error: 'Appointments must be between 08:00 and 18:00.' }
  }

  return { valid: true }
}

function timeToMinutes(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}

function buildTimeRange(dateValue, timeValue) {
  const timestamp = new Date(`${dateValue}T${timeValue}:00`).getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

function getReminderQueue() {
  const today = getLocalDateKey()
  const rows = db.prepare("SELECT * FROM slots WHERE status = 'booked' AND date >= ? ORDER BY date, time").all(today)

  return rows.filter((booking) => {
    const slotTime = buildTimeRange(booking.date, booking.time)
    if (!slotTime) return false

    const hoursUntilMeeting = (slotTime - Date.now()) / (1000 * 60 * 60)
    const lastReminder = booking.last_reminder_at ? new Date(booking.last_reminder_at).getTime() : 0
    const reminderCooldownElapsed = Date.now() - lastReminder > 6 * 60 * 60 * 1000

    return hoursUntilMeeting <= 24 && hoursUntilMeeting > 0 && reminderCooldownElapsed
  })
}

async function sendScheduledReminders() {
  const queue = getReminderQueue()

  for (const booking of queue) {
    try {
      await sendReminderEmail({
        student: booking.student,
        email: booking.email,
        topic: booking.topic,
        date: booking.date,
        time: booking.time,
      })

      db.prepare('UPDATE slots SET last_reminder_at = ? WHERE id = ?').run(new Date().toISOString(), booking.id)
    } catch (error) {
      console.error('Scheduled reminder failed:', error)
    }
  }
}

db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 30, status TEXT NOT NULL DEFAULT 'available',
    student TEXT, email TEXT, matric_no TEXT, level TEXT, department TEXT,
    topic TEXT, is_emergency INTEGER NOT NULL DEFAULT 0,
    last_reminder_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, time)
  );
`)
const slotColumns = new Set(db.prepare('PRAGMA table_info(slots)').all().map((column) => column.name))
for (const [column, definition] of [
  ['matric_no', 'TEXT'],
  ['level', 'TEXT'],
  ['department', 'TEXT'],
  ['is_emergency', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_reminder_at', 'TEXT'],
]) {
  if (!slotColumns.has(column)) db.exec(`ALTER TABLE slots ADD COLUMN ${column} ${definition}`)
}
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, student TEXT NOT NULL, email TEXT NOT NULL,
    topic TEXT, urgency TEXT NOT NULL DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lecturer_account (
    id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lecturer_reset_codes (
    id INTEGER PRIMARY KEY CHECK (id = 1), code_hash TEXT NOT NULL, salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS lecturer_sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_otps (
    email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS funnel_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)

const seed = db.prepare('SELECT COUNT(*) AS count FROM slots').get().count === 0
if (seed && process.env.NODE_ENV !== 'production') {
  const add = db.prepare('INSERT INTO slots (id, date, time, duration, status, student, email, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const examples = [
    ['2026-10-05', '09:00', 'available'], ['2026-10-05', '10:00', 'available'], ['2026-10-05', '11:30', 'booked', 'Amara Okafor', 'amara@example.com', 'Research proposal feedback'],
    ['2026-10-06', '09:30', 'available'], ['2026-10-06', '11:00', 'available'], ['2026-10-06', '14:00', 'booked', 'Daniel Mensah', 'daniel@example.com', 'Coursework clarification'],
    ['2026-10-07', '10:00', 'available'], ['2026-10-07', '13:00', 'available'], ['2026-10-08', '09:00', 'available'], ['2026-10-08', '11:00', 'available'], ['2026-10-09', '10:30', 'available'], ['2026-10-09', '14:00', 'available'],
  ]
  for (const [date, time, status, student = null, email = null, topic = null] of examples) add.run(randomUUID(), date, time, 30, status, student, email, topic)
}

function getTokenFromRequest(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function requireLecturer(req, res, next) {
  res.setHeader('Cache-Control', 'no-store')
  const token = getTokenFromRequest(req)
  const session = token
    ? db.prepare('SELECT token_hash FROM lecturer_sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now())
    : null

  if (!session) {
    if (token) db.prepare('DELETE FROM lecturer_sessions WHERE token_hash = ?').run(hashToken(token))
    return res.status(401).json({ error: 'Lecturer access required.' })
  }

  req.lecturer = LECTURER
  next()
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

// Same inbox, different spelling: Gmail ignores dots and +tags in the local part.
function canonicalEmail(email) {
  const [local = '', domain = ''] = normalizeEmail(email).split('@')
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`
  }
  return `${local}@${domain}`
}

function generateOtp() {
  return String(randomInt(100000, 1000000))
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

function passwordMatches(password, account) {
  const expected = Buffer.from(account.password_hash, 'hex')
  const actual = Buffer.from(hashPassword(password, account.salt), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Your password must be at least 10 characters long.'
  if (password.length > 128) return 'Your password is too long.'
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Your password must contain letters and at least one number.'
  if (normalizeEmail(password) === normalizeEmail(LECTURER.email)) return 'Your password cannot be your email address.'
  return null
}

function hashOtp(otp, salt) {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex')
}

function isConfiguredMailServer() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function getMailFrom() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@university.edu'
}

function createMailTransport() {
  return isConfiguredMailServer()
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT || 587) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })
    : nodemailer.createTransport({
        jsonTransport: true,
      })
}

async function sendOtpEmail(email, otp, studentName = '') {
  if (!isConfiguredMailServer()) {
    throw new Error('SMTP email delivery is not configured.')
  }

  const transporter = createMailTransport()
  const greetingName = String(studentName || '').trim().replace(/[\r\n]/g, '') || 'there'

  const mailOptions = {
    from: getMailFrom(),
    to: email,
    subject: 'Verify your appointment email',
    text: `Hi ${greetingName},\n\nYou’re one step away from booking your appointment with ${LECTURER.name}. Enter this code on the booking page to verify your email:\n\n${otp}\n\nThis code expires in 5 minutes and can only be used once. If you didn’t request it, you can ignore this email.\n\nSee you soon,\n${LECTURER.name}’s Appointment Desk`,
    html: `<p>Hi ${greetingName.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])},</p><p>You’re one step away from booking your appointment with ${LECTURER.name}. Enter this code on the booking page to verify your email:</p><p style="font-size:28px;font-weight:bold;letter-spacing:5px">${otp}</p><p>This code expires in 5 minutes and can only be used once. If you didn’t request it, you can ignore this email.</p><p>See you soon,<br>${LECTURER.name}’s Appointment Desk</p>`,
  }

  return transporter.sendMail(mailOptions)
}

async function sendLecturerResetEmail(otp, isSetup) {
  const transporter = createMailTransport()
  const action = isSetup ? 'create your password' : 'reset your password'
  return transporter.sendMail({
    from: getMailFrom(),
    to: LECTURER.email,
    subject: isSetup ? 'Create your lecturer password' : 'Reset your lecturer password',
    text: `Hi ${LECTURER.name},\n\nUse this code to ${action} for the appointment dashboard:\n\n${otp}\n\nThis code expires in 10 minutes and can only be used once. If you didn’t request it, you can ignore this email.`,
    html: `<p>Hi ${LECTURER.name},</p><p>Use this code to ${action} for the appointment dashboard:</p><p style="font-size:28px;font-weight:bold;letter-spacing:5px">${otp}</p><p>This code expires in 10 minutes and can only be used once. If you didn’t request it, you can ignore this email.</p>`,
  })
}

async function sendBookingNotificationEmail({ student, email, matricNo, level, department, topic, date, time }) {
  const lecturerEmail = LECTURER.email
  const transporter = createMailTransport()

  const mailOptions = {
    from: getMailFrom(),
    to: lecturerEmail,
    subject: 'New appointment booked',
    text: `A new student appointment has been booked.\n\nStudent: ${student}\nMatric number: ${matricNo}\nLevel: ${level}\nDepartment: ${department}\nEmail: ${email}\nDate: ${date}\nTime: ${time}\nTopic: ${topic || 'Not provided'}`,
  }

  const info = await transporter.sendMail(mailOptions)

  if (!isConfiguredMailServer()) {
    console.log(`New booking notification for ${lecturerEmail}: ${student} booked ${date} at ${time}`)
    return { ...info, debugCode: null }
  }

  return info
}

async function sendStudentBookingConfirmationEmail({ student, email, matricNo, level, department, topic, date, time }) {
  const transporter = createMailTransport()

  const mailOptions = {
    from: getMailFrom(),
    to: email,
    subject: 'Your appointment has been confirmed',
    text: `Hello ${student},\n\nYour appointment with ${LECTURER.name} has been confirmed.\n\nMatric number: ${matricNo}\nLevel: ${level}\nDepartment: ${department}\nDate: ${date}\nTime: ${time}\nReason: ${topic || 'No reason provided'}\n\nPlease arrive a few minutes early and bring any supporting materials you want to discuss.`,
  }

  const info = await transporter.sendMail(mailOptions)

  if (!isConfiguredMailServer()) {
    console.log(`Student confirmation email to ${email}: ${student} booked ${date} at ${time}`)
    return { ...info, debugCode: null }
  }

  return info
}

async function sendReminderEmail({ student, email, topic, date, time }) {
  const transporter = createMailTransport()

  const mailOptions = {
    from: getMailFrom(),
    to: email,
    subject: 'Reminder: your appointment is coming up',
    text: `Hello ${student},\n\nThis is a reminder that your appointment with ${LECTURER.name} is scheduled for ${date} at ${time}.\n\nReason: ${topic || 'No reason provided'}\n\nPlease reply to this email if you need to reschedule or cancel.`,
  }

  const info = await transporter.sendMail(mailOptions)

  if (!isConfiguredMailServer()) {
    console.log(`Reminder email to ${email}: ${student} on ${date} at ${time}`)
    return { ...info, debugCode: null }
  }

  return info
}

async function sendWaitlistNotificationEmail({ student, email, date, time }) {
  const transporter = createMailTransport()

  const mailOptions = {
    from: getMailFrom(),
    to: email,
    subject: 'A slot is available for your waitlist request',
    text: `Hello ${student},\n\nA new appointment slot has opened for ${date} at ${time}.\n\nPlease log in to the office booking page and confirm your booking as soon as possible.`,
  }

  const info = await transporter.sendMail(mailOptions)

  if (!isConfiguredMailServer()) {
    console.log(`Waitlist notification email to ${email}: ${student} for ${date} at ${time}`)
    return { ...info, debugCode: null }
  }

  return info
}

async function sendAttendanceDecisionEmail({ student, email, date, time, recipientType, shouldAttend }) {
  if (!isConfiguredMailServer()) {
    throw new Error('SMTP email delivery is not configured.')
  }

  const isWaitlistInvitation = recipientType === 'waitlist' && shouldAttend
  const subject = shouldAttend
    ? (isWaitlistInvitation ? 'The lecturer invites you to come in' : 'Please attend your appointment')
    : 'Please do not come to the office'
  const schedule = `${date}${time ? ` at ${time}` : ''}`
  const instruction = shouldAttend
    ? (isWaitlistInvitation
        ? `Mrs Charity would like you to come to the office on ${schedule}. This is an invitation from the waitlist and is not a confirmed appointment time. Please reply to this email to confirm the time before travelling.`
        : `Mrs Charity confirms that you should come to the office for your appointment on ${schedule}. Please arrive a few minutes early.`)
    : `Mrs Charity has asked you not to come to the office on ${schedule}. Please wait for further instructions. If you already have a booked appointment, it remains booked unless you receive a separate cancellation.`

  return createMailTransport().sendMail({
    from: getMailFrom(),
    to: email,
    subject,
    text: `Hello ${String(student || 'there').replace(/[\r\n]/g, '')},\n\n${instruction}\n\nIf you have questions, reply to this email.\n\n${LECTURER.name}`,
  })
}

const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
app.use(helmet())
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1)
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json({ limit: '16kb' }))

const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: { error: 'Too many requests. Please try again later.' },
})
app.use('/api', apiRateLimit)

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
})
const otpRequestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification emails requested. Try again in 15 minutes.' },
})
const otpVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Request a new code later.' },
})
const sensitiveActionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
})

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/api/slots', (req, res) => {
  let { from, to } = req.query
  if (!from && !to) {
    from = getLocalDateKey()
    const end = new Date(`${from}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 60)
    to = end.toISOString().slice(0, 10)
  }
  if ((from && (typeof from !== 'string' || !validateDateString(from).valid)) || (to && (typeof to !== 'string' || !validateDateString(to).valid)) || Boolean(from) !== Boolean(to) || (from && from > to)) {
    return res.status(400).json({ error: 'Choose a valid appointment date range.' })
  }
  if (from && to && (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 > 60) {
    return res.status(400).json({ error: 'Appointment date ranges cannot exceed 60 days.' })
  }
  const rows = db.prepare('SELECT id, date, time, duration, status, is_emergency FROM slots WHERE date BETWEEN ? AND ? ORDER BY date, time').all(from, to)
  res.json(rows)
})
app.get('/api/slots/manage', requireLecturer, (_req, res) => {
  res.json(db.prepare('SELECT * FROM slots ORDER BY date, time').all())
})
app.get('/api/analytics', requireLecturer, (_req, res) => {
  const totals = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'booked') AS booked, SUM(status = 'available') AS available FROM slots").get()
  const upcoming = db.prepare("SELECT * FROM slots WHERE status = 'booked' ORDER BY date, time LIMIT 5").all()
  const today = getLocalDateKey()
  const todayAppointments = db.prepare("SELECT COUNT(*) AS count FROM slots WHERE status = 'booked' AND date = ?").get(today).count
  const waitlistCount = db.prepare("SELECT COUNT(*) AS count FROM waitlist WHERE status = 'waiting'").get().count
  const funnel = db.prepare('SELECT event, COUNT(*) AS count FROM funnel_events GROUP BY event').all()

  res.json({
    total: Number(totals.total || 0),
    booked: Number(totals.booked || 0),
    available: Number(totals.available || 0),
    todayAppointments,
    waitlistCount,
    funnel: Object.fromEntries(funnel.map(({ event, count }) => [event, count])),
    upcoming,
  })
})
app.get('/api/bookings/history', requireLecturer, (_req, res) => {
  const rows = db.prepare("SELECT * FROM slots WHERE status = 'booked' ORDER BY date DESC, time DESC LIMIT 20").all()
  res.json(rows)
})
app.get('/api/lecturer/status', (_req, res) => {
  res.json({ hasPassword: Boolean(db.prepare('SELECT 1 FROM lecturer_account WHERE id = 1').get()) })
})
app.post('/api/lecturer/password/request-code', otpRequestRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' })
  }
  if (!isConfiguredMailServer()) {
    return res.status(503).json({ error: 'Email delivery is not configured. Add valid SMTP settings to the server environment.' })
  }

  const genericReply = { success: true, message: 'If that is the lecturer email, a verification code has been sent to it.' }
  if (email !== normalizeEmail(LECTURER.email)) return res.json(genericReply)

  const isSetup = !db.prepare('SELECT 1 FROM lecturer_account WHERE id = 1').get()
  const otp = generateOtp()
  const salt = randomUUID()
  db.prepare(`INSERT INTO lecturer_reset_codes (id, code_hash, salt, expires_at, attempts) VALUES (1, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, attempts = 0`)
    .run(hashOtp(otp, salt), salt, Date.now() + 10 * 60 * 1000)

  try {
    await sendLecturerResetEmail(otp, isSetup)
    return res.json(genericReply)
  } catch (error) {
    db.prepare('DELETE FROM lecturer_reset_codes WHERE id = 1').run()
    console.error('Lecturer reset email failed:', error)
    return res.status(502).json({ error: 'Could not deliver the verification email. Check the SMTP settings and try again.' })
  }
})
app.post('/api/lecturer/password/set', otpVerifyRateLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
  const password = req.body?.password

  if (email !== normalizeEmail(LECTURER.email) || !/^\d{6}$/.test(code)) {
    return res.status(401).json({ error: 'The verification code is incorrect or has expired.' })
  }
  const problem = passwordProblem(password)
  if (problem) return res.status(400).json({ error: problem })

  const stored = db.prepare('SELECT * FROM lecturer_reset_codes WHERE id = 1').get()
  if (!stored || stored.expires_at < Date.now() || stored.attempts >= 5) {
    db.prepare('DELETE FROM lecturer_reset_codes WHERE id = 1').run()
    return res.status(401).json({ error: 'The verification code is incorrect or has expired. Please request a new one.' })
  }
  if (hashOtp(code, stored.salt) !== stored.code_hash) {
    db.prepare('UPDATE lecturer_reset_codes SET attempts = attempts + 1 WHERE id = 1').run()
    return res.status(401).json({ error: 'The verification code is incorrect or has expired.' })
  }

  const salt = randomBytes(16).toString('hex')
  db.transaction(() => {
    db.prepare(`INSERT INTO lecturer_account (id, password_hash, salt, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, salt = excluded.salt, updated_at = CURRENT_TIMESTAMP`)
      .run(hashPassword(password, salt), salt)
    db.prepare('DELETE FROM lecturer_reset_codes WHERE id = 1').run()
    db.prepare('DELETE FROM lecturer_sessions').run()
  })()
  res.json({ success: true, message: 'Your password has been saved. You can now sign in.' })
})
app.post('/api/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body || {}
  const account = db.prepare('SELECT * FROM lecturer_account WHERE id = 1').get()

  if (!account) {
    return res.status(409).json({ error: 'Create your lecturer password first.', setupRequired: true })
  }
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256 || !email || !password || normalizeEmail(email) !== normalizeEmail(LECTURER.email) || !passwordMatches(password, account)) {
    return res.status(401).json({ error: 'Invalid lecturer credentials.' })
  }
  const token = randomUUID()
  const expiresAt = Date.now() + SESSION_TTL_MS
  db.prepare('DELETE FROM lecturer_sessions WHERE expires_at <= ?').run(Date.now())
  db.prepare('INSERT INTO lecturer_sessions (token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), expiresAt)

  res.json({
    token,
    lecturer: { name: LECTURER.name, email: LECTURER.email },
  })
})
app.post('/api/logout', requireLecturer, (req, res) => {
  const token = getTokenFromRequest(req)
  if (token) db.prepare('DELETE FROM lecturer_sessions WHERE token_hash = ?').run(hashToken(token))
  res.json({ success: true })
})
app.get('/api/session', requireLecturer, (req, res) => {
  res.json({ lecturer: { name: req.lecturer.name, email: req.lecturer.email } })
})
app.post('/api/slots', requireLecturer, (req, res) => {
  const { date, time, duration = 30, isEmergency = false } = req.body || {}
  if (typeof date !== 'string' || typeof time !== 'string' || (typeof duration !== 'number' && typeof duration !== 'string') || typeof isEmergency !== 'boolean') {
    return res.status(400).json({ error: 'Provide a valid date, time, duration, and emergency flag.' })
  }
  const dateValidation = validateDateString(date)
  if (!dateValidation.valid) return res.status(400).json({ error: dateValidation.error })

  const timeValidation = validateTimeString(time)
  if (!timeValidation.valid) return res.status(400).json({ error: timeValidation.error })

  const slotDuration = Number(duration)
  if (!Number.isInteger(slotDuration) || slotDuration < 15 || slotDuration > 120) {
    return res.status(400).json({ error: 'Appointment duration must be between 15 and 120 whole minutes.' })
  }
  if (timeToMinutes(time) + slotDuration > 18 * 60) {
    return res.status(400).json({ error: 'The appointment must finish by 18:00.' })
  }

  const emergencyMode = Boolean(isEmergency)
  if (emergencyMode) {
    const today = getLocalDateKey()
    if (date !== today) {
      return res.status(400).json({ error: 'Emergency slots can only be added for today.' })
    }
  }

  try {
    const id = randomUUID()
    const createSlot = db.transaction(() => {
      const existingSlots = db.prepare('SELECT time, duration, status FROM slots WHERE date = ?').all(date)
      const newStart = timeToMinutes(time)
      const overlap = existingSlots.find((slot) => {
        const existingStart = timeToMinutes(slot.time)
        return newStart < existingStart + slot.duration && existingStart < newStart + slotDuration
      })
      if (overlap) return { overlap }

      db.prepare('INSERT INTO slots (id, date, time, duration, is_emergency) VALUES (?, ?, ?, ?, ?)').run(id, date, time, slotDuration, emergencyMode ? 1 : 0)
      return { slot: db.prepare('SELECT * FROM slots WHERE id = ?').get(id) }
    })
    const result = createSlot.immediate()
    if (result.overlap) {
      if (result.overlap.time === time) {
        return res.status(409).json({ error: `A ${result.overlap.status} slot already exists at that date and time.` })
      }
      return res.status(409).json({
        error: `This time overlaps the ${result.overlap.status} slot at ${result.overlap.time}. Choose a non-overlapping time.`,
      })
    }
    res.status(201).json(result.slot)
  } catch (error) {
    console.error('Create slot failed:', error)
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A slot already exists at that date and time.' })
    }
    res.status(500).json({ error: 'Could not create the slot. Please try again.' })
  }
})
app.delete('/api/slots/:id', requireLecturer, (req, res) => {
  const result = db.prepare('DELETE FROM slots WHERE id = ? AND status = ?').run(req.params.id, 'available')
  if (!result.changes) return res.status(404).json({ error: 'Available slot not found.' })
  res.status(204).end()
})
app.post('/api/email/otp/request', otpRequestRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const studentName = typeof req.body?.student === 'string' ? req.body.student.trim() : ''
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || studentName.length > 100) {
    return res.status(400).json({ error: 'Enter a valid student email address.' })
  }

  if (!isConfiguredMailServer()) {
    return res.status(503).json({ error: 'Email delivery is not configured. Add valid SMTP settings to the server environment.' })
  }

  const otp = generateOtp()
  const expiresAt = Date.now() + OTP_TTL_MS
  const salt = randomUUID()
  db.prepare(`INSERT INTO email_otps (email, code_hash, salt, expires_at, verified, attempts, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?)
    ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt,
      expires_at = excluded.expires_at, verified = 0, attempts = 0, created_at = excluded.created_at`)
    .run(email, hashOtp(otp, salt), salt, expiresAt, Date.now())

  try {
    await sendOtpEmail(email, otp, studentName)
    return res.json({ success: true, message: 'Verification code sent to your email. Check your inbox and spam folder.' })
  } catch (error) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(email)
    console.error('OTP send failed:', error)
    return res.status(502).json({ error: 'Could not deliver the verification email. Check the SMTP settings and try again.' })
  }
})

app.post('/api/email/otp/verify', otpVerifyRateLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : ''

  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'Enter a valid email address and six-digit OTP.' })
  }

  const stored = db.prepare('SELECT * FROM email_otps WHERE email = ?').get(email)
  if (!stored || stored.expires_at < Date.now()) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(email)
    return res.status(401).json({ error: 'Your verification code has expired. Please request a new one.' })
  }

  if (stored.attempts >= 5) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(email)
    return res.status(429).json({ error: 'Too many incorrect codes. Please request a new one.' })
  }

  if (hashOtp(otp, stored.salt) !== stored.code_hash) {
    const attempts = stored.attempts + 1
    if (attempts >= 5) db.prepare('DELETE FROM email_otps WHERE email = ?').run(email)
    else db.prepare('UPDATE email_otps SET attempts = ? WHERE email = ?').run(attempts, email)
    return res.status(401).json({ error: 'The OTP is incorrect.' })
  }

  db.prepare('UPDATE email_otps SET verified = 1, expires_at = ? WHERE email = ?').run(Date.now() + VERIFIED_TTL_MS, email)
  const verifiedUntil = Date.now() + VERIFIED_TTL_MS
  return res.json({ success: true, message: 'Email verified successfully.', verifiedUntil })
})

app.post('/api/analytics/events', (req, res) => {
  const { event } = req.body || {}
  const allowedEvents = new Set(['booking_page_view', 'otp_requested', 'email_verified', 'slot_selected', 'booking_confirmed'])
  if (typeof event !== 'string' || !allowedEvents.has(event)) {
    return res.status(400).json({ error: 'Choose a supported analytics event.' })
  }
  db.prepare('INSERT INTO funnel_events (event) VALUES (?)').run(event)
  db.prepare("DELETE FROM funnel_events WHERE created_at < datetime('now', '-90 days')").run()
  res.status(202).end()
})

app.post('/api/bookings', sensitiveActionRateLimit, async (req, res) => {
  const { slotId, student, email, matricNo, level, department, topic = '', otp } = req.body || {}
  const normalizedStudent = typeof student === 'string' ? student.trim() : ''
  const normalizedTopic = typeof topic === 'string' ? topic.trim() : ''
  const normalizedEmail = normalizeEmail(email)
  const normalizedMatricNo = typeof matricNo === 'string' ? matricNo.trim() : ''
  const normalizedLevel = typeof level === 'string' ? level.trim() : ''
  const normalizedDepartment = typeof department === 'string' ? department.trim() : ''
  const normalizedOtp = typeof otp === 'string' ? otp.trim() : ''

  if (typeof slotId !== 'string' || slotId.length > 64 || !normalizedStudent || normalizedStudent.length > 100 || normalizedTopic.length > 1000 || normalizedEmail.length > 254 || !/^\S+@\S+\.\S+$/.test(normalizedEmail) || !normalizedMatricNo || !normalizedLevel || !normalizedDepartment) {
    return res.status(400).json({ error: 'Add your name, matric number, level, department, and a valid email address.' })
  }
  if (normalizedMatricNo.length > 40 || normalizedLevel.length > 40 || normalizedDepartment.length > 120) {
    return res.status(400).json({ error: 'Matric number, level, or department is too long.' })
  }

  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId)
  if (!slot) {
    return res.status(404).json({ error: 'That appointment could not be found.' })
  }

  const dateValidation = validateDateString(slot.date)
  if (!dateValidation.valid) {
    return res.status(400).json({ error: dateValidation.error })
  }

  const timeValidation = validateTimeString(slot.time)
  if (!timeValidation.valid) {
    return res.status(400).json({ error: timeValidation.error })
  }

  const verifiedRecord = db.prepare('SELECT * FROM email_otps WHERE email = ?').get(normalizedEmail)
  if (!verifiedRecord || verifiedRecord.expires_at < Date.now() || !verifiedRecord.verified) {
    return res.status(401).json({ error: 'Verify your email before booking.' })
  }

  if (!/^\d{6}$/.test(normalizedOtp) || hashOtp(normalizedOtp, verifiedRecord.salt) !== verifiedRecord.code_hash) {
    return res.status(401).json({ error: 'The OTP does not match the verified email.' })
  }

  const createBooking = db.transaction(() => {
    const matricKey = normalizedMatricNo.replace(/[\s/.\-]+/g, '').toUpperCase()
    const emailKey = canonicalEmail(normalizedEmail)
    const existingBooking = db.prepare("SELECT id, date, time, email, matric_no FROM slots WHERE date >= ? AND status = 'booked'").all(getLocalDateKey())
      .find((row) => canonicalEmail(row.email) === emailKey || (matricKey && String(row.matric_no || '').replace(/[\s/.\-]+/g, '').toUpperCase() === matricKey))
    if (existingBooking) return { conflict: 'already_booked', existingBooking }

    const result = db.prepare("UPDATE slots SET status = 'booked', student = ?, email = ?, matric_no = ?, level = ?, department = ?, topic = ? WHERE id = ? AND status = 'available'").run(normalizedStudent, normalizedEmail, normalizedMatricNo, normalizedLevel, normalizedDepartment, normalizedTopic, slotId)
    if (!result.changes) return { conflict: 'slot_unavailable' }

    return { bookedSlot: db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId) }
  })
  const bookingResult = createBooking.immediate()

  if (bookingResult.conflict === 'already_booked') {
    return res.status(409).json({
      error: 'You already have an upcoming appointment. Only one booking is allowed per student at a time. Please attend it or ask the lecturer to cancel it first.',
      existingBooking: bookingResult.existingBooking,
    })
  }
  if (bookingResult.conflict === 'slot_unavailable') {
    return res.status(409).json({ error: 'That appointment is no longer available.' })
  }

  const { bookedSlot } = bookingResult
  db.prepare('DELETE FROM email_otps WHERE email = ?').run(normalizedEmail)

  const emailDelivery = {
    lecturerNotification: false,
    studentConfirmation: false,
  }

  try {
    await sendBookingNotificationEmail({
      student: normalizedStudent,
      email: normalizedEmail,
      matricNo: normalizedMatricNo,
      level: normalizedLevel,
      department: normalizedDepartment,
      topic: normalizedTopic,
      date: bookedSlot.date,
      time: bookedSlot.time,
    })
    emailDelivery.lecturerNotification = true
  } catch (error) {
    console.error('Lecturer booking notification failed:', error)
  }

  try {
    await sendStudentBookingConfirmationEmail({
      student: normalizedStudent,
      email: normalizedEmail,
      matricNo: normalizedMatricNo,
      level: normalizedLevel,
      department: normalizedDepartment,
      topic: normalizedTopic,
      date: bookedSlot.date,
      time: bookedSlot.time,
    })
    emailDelivery.studentConfirmation = true
  } catch (error) {
    console.error('Student booking confirmation failed:', error)
  }

  res.status(201).json({
    ...bookedSlot,
    confirmation: { student: normalizedStudent, email: normalizedEmail, matricNo: normalizedMatricNo, level: normalizedLevel, department: normalizedDepartment, date: bookedSlot.date, time: bookedSlot.time, topic: normalizedTopic },
    emailDelivery,
  })
})
app.delete('/api/bookings/:id', requireLecturer, async (req, res) => {
  const cancelledSlot = db.prepare("SELECT * FROM slots WHERE id = ? AND status = 'booked'").get(req.params.id)
  if (!cancelledSlot) return res.status(404).json({ error: 'Booking not found.' })

  const result = db.prepare("UPDATE slots SET status = 'available', student = NULL, email = NULL, matric_no = NULL, level = NULL, department = NULL, topic = NULL WHERE id = ? AND status = 'booked'").run(req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Booking not found.' })

  const waitlistEntry = db.prepare('SELECT * FROM waitlist WHERE date = ? AND status = ? ORDER BY created_at ASC LIMIT 1').get(cancelledSlot.date, 'waiting')
  if (waitlistEntry) {
    db.prepare("UPDATE waitlist SET status = 'notified' WHERE id = ?").run(waitlistEntry.id)
    try {
      await sendWaitlistNotificationEmail({
        student: waitlistEntry.student,
        email: waitlistEntry.email,
        date: waitlistEntry.date,
        time: cancelledSlot.time,
      })
    } catch (error) {
      console.error('Waitlist notification failed:', error)
    }
  }

  res.status(204).end()
})
app.post('/api/waitlist', sensitiveActionRateLimit, (req, res) => {
  const { date, student, email, topic = '', urgency = 'standard', otp } = req.body || {}
  const normalizedEmail = normalizeEmail(email)
  const normalizedName = typeof student === 'string' ? student.trim() : ''
  const normalizedTopic = typeof topic === 'string' ? topic.trim() : ''
  const normalizedOtp = typeof otp === 'string' ? otp.trim() : ''
  const dateValidation = validateDateString(date)

  if (typeof date !== 'string' || !dateValidation.valid || !normalizedName || normalizedName.length > 100 || normalizedTopic.length > 1000 || normalizedEmail.length > 254 || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Add your name and a valid email to join the waitlist.' })
  }
  if (!['standard', 'urgent'].includes(urgency)) {
    return res.status(400).json({ error: 'Choose a valid waitlist urgency.' })
  }

  const verification = db.prepare('SELECT * FROM email_otps WHERE email = ?').get(normalizedEmail)
  if (!verification || verification.expires_at < Date.now() || !verification.verified) {
    return res.status(401).json({ error: 'Verify your email before joining the waitlist.' })
  }
  if (!/^\d{6}$/.test(normalizedOtp) || hashOtp(normalizedOtp, verification.salt) !== verification.code_hash) {
    return res.status(401).json({ error: 'The OTP does not match the verified email.' })
  }

  const existing = db.prepare('SELECT * FROM waitlist WHERE date = ? AND email = ? AND status = ?').get(date, normalizedEmail, 'waiting')
  if (existing) {
    return res.status(409).json({ error: 'You are already on the waitlist for this date.' })
  }

  const id = randomUUID()
  db.prepare('INSERT INTO waitlist (id, date, student, email, topic, urgency) VALUES (?, ?, ?, ?, ?, ?)').run(id, date, normalizedName, normalizedEmail, normalizedTopic, urgency)
  db.prepare('DELETE FROM email_otps WHERE email = ?').run(normalizedEmail)
  res.status(201).json({ id, date, student: normalizedName, email: normalizedEmail, urgency })
})
app.get('/api/waitlist', requireLecturer, (_req, res) => {
  const rows = db.prepare('SELECT * FROM waitlist WHERE status = ? ORDER BY date, created_at').all('waiting')
  res.json(rows)
})
app.post('/api/attendance-notices', sensitiveActionRateLimit, requireLecturer, async (req, res) => {
  const { recipientType, recipientId, shouldAttend } = req.body || {}
  if (!['booking', 'waitlist'].includes(recipientType) || !recipientId || typeof shouldAttend !== 'boolean') {
    return res.status(400).json({ error: 'Choose a booking or waitlist student and whether they should come.' })
  }
  if (!isConfiguredMailServer()) {
    return res.status(503).json({ error: 'Email delivery is not configured. Add valid SMTP settings before sending notices.' })
  }

  const record = recipientType === 'booking'
    ? db.prepare("SELECT id, student, email, date, time FROM slots WHERE id = ? AND status = 'booked'").get(recipientId)
    : db.prepare("SELECT id, student, email, date, NULL AS time FROM waitlist WHERE id = ? AND status = 'waiting'").get(recipientId)
  if (!record) {
    return res.status(404).json({ error: recipientType === 'booking' ? 'Booked appointment not found.' : 'Waiting student not found.' })
  }

  try {
    await sendAttendanceDecisionEmail({ ...record, recipientType, shouldAttend })
    return res.json({ success: true, message: `Email sent to ${record.student}.` })
  } catch (error) {
    console.error('Attendance notice email failed:', error)
    return res.status(502).json({ error: 'Could not send the email. Check the mail settings and try again.' })
  }
})
app.delete('/api/waitlist/:id', requireLecturer, (req, res) => {
  const result = db.prepare("UPDATE waitlist SET status = 'removed' WHERE id = ? AND status = 'waiting'").run(req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Waitlist request not found.' })
  res.status(204).end()
})
app.get('/api/bookings', requireLecturer, (_req, res) => {
  const rows = db.prepare("SELECT * FROM slots WHERE status = 'booked' ORDER BY date, time").all()
  res.json(rows)
})
app.post('/api/email/reminders/send', sensitiveActionRateLimit, requireLecturer, async (_req, res) => {
  const today = getLocalDateKey()
  const upcoming = db.prepare("SELECT * FROM slots WHERE status = 'booked' AND date >= ? ORDER BY date, time").all(today)
  const reminders = upcoming.filter((booking) => {
    const date = new Date(`${booking.date}T${booking.time}:00`)
    const diffHours = (date.getTime() - Date.now()) / (1000 * 60 * 60)
    return diffHours <= 24 && diffHours > 0
  })

  let sent = 0
  for (const booking of reminders) {
    try {
      await sendReminderEmail({
        student: booking.student,
        email: booking.email,
        topic: booking.topic,
        date: booking.date,
        time: booking.time,
      })
      sent += 1
    } catch (error) {
      console.error('Reminder email failed:', error)
    }
  }

  res.json({ success: true, sent, total: reminders.length })
})
app.get('/api/stats', (_req, res) => {
  const stats = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'booked') AS booked, SUM(status = 'available') AS available FROM slots").get()
  const nextBooking = db.prepare("SELECT id, date, time, duration FROM slots WHERE status = 'booked' ORDER BY date, time LIMIT 1").get()
  res.json({
    total: Number(stats.total || 0),
    booked: Number(stats.booked || 0),
    available: Number(stats.available || 0),
    nextBooking: nextBooking || null,
  })
})

const isDirectlyLaunched = import.meta.url === pathToFileURL(process.argv[1]).href

app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }))
app.use((error, _req, res, _next) => {
  if (res.headersSent) return
  const status = error.status === 413 ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : 500
  if (status === 500) console.error('Unhandled request error:', error.message)
  res.status(status).json({ error: status === 413 ? 'Request body is too large.' : status === 400 ? 'Request body must contain valid JSON.' : 'An unexpected error occurred. Please try again.' })
})

if (isDirectlyLaunched) {
  cron.schedule('*/15 * * * *', sendScheduledReminders)
  app.listen(port, () => console.log(`Appointment API running at http://localhost:${port}`))
}

export { app }
