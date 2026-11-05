import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
import { connectMongo } from './mongodb.js'
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
  throw new Error('APPOINTMENT_TIME_ZONE must be a valid IANA timezone, such as Europe/London.')
}
process.env.TZ = appointmentTimeZone
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
    ['MONGODB_URI', process.env.MONGODB_URI],
    ['APPOINTMENT_TIME_ZONE', process.env.APPOINTMENT_TIME_ZONE],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missingSettings.length) {
    throw new Error(`Missing required production environment settings: ${missingSettings.join(', ')}`)
  }
  if (!/^\S+@\S+\.\S+$/.test(LECTURER.email)) {
    throw new Error('LECTURER_EMAIL must be a valid email address in production.')
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

const { client: mongoClient, database: mongoDatabase, collections } = await connectMongo()
const slots = collections.slots
const waitlist = collections.waitlist
const lecturerAccounts = collections.lecturerAccounts
const lecturerResetCodes = collections.lecturerResetCodes
const lecturerSessions = collections.lecturerSessions
const emailOtps = collections.emailOtps
const funnelEvents = collections.funnelEvents
const bookingLocks = collections.bookingLocks
const slotDateLocks = collections.slotDateLocks
const recordWithoutMongoId = (record) => {
  if (!record) return record
  const { _id: _mongoId, ...rest } = record
  return rest
}
const recordsWithoutMongoIds = (records) => records.map(recordWithoutMongoId)

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

async function getReminderQueue() {
  const today = getLocalDateKey()
  const rows = await slots.find({ status: 'booked', date: { $gte: today } }).sort({ date: 1, time: 1 }).toArray()

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
  const queue = await getReminderQueue()

  for (const booking of queue) {
    try {
      await sendReminderEmail({
        student: booking.student,
        email: booking.email,
        topic: booking.topic,
        date: booking.date,
        time: booking.time,
      })

      await slots.updateOne({ id: booking.id }, { $set: { last_reminder_at: new Date().toISOString() } })
    } catch (error) {
      console.error('Scheduled reminder failed:', error)
    }
  }
}

const seed = await slots.countDocuments() === 0
if (seed && process.env.NODE_ENV !== 'production') {
  const examples = [
    [1, '09:00', 'available'], [1, '10:00', 'available'], [1, '11:30', 'booked', 'Amara Okafor', 'amara@example.com', 'Research proposal feedback'],
    [2, '09:30', 'available'], [2, '11:00', 'available'], [2, '14:00', 'booked', 'Daniel Mensah', 'daniel@example.com', 'Coursework clarification'],
    [3, '10:00', 'available'], [3, '13:00', 'available'], [4, '09:00', 'available'], [4, '11:00', 'available'], [5, '10:30', 'available'], [5, '14:00', 'available'],
  ]
  await slots.insertMany(examples.map(([daysAhead, time, status, student = null, email = null, topic = null]) => {
    const appointmentDate = new Date()
    appointmentDate.setDate(appointmentDate.getDate() + daysAhead)
    const date = getLocalDateKey(appointmentDate)
    return {
      id: randomUUID(), date, time, duration: 30, status, student, email, topic,
      is_emergency: 0, created_at: new Date().toISOString(),
    }
  }))
}

function getTokenFromRequest(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function requireLecturer(req, res, next) {
  res.setHeader('Cache-Control', 'no-store')
  const token = getTokenFromRequest(req)
  const session = token
    ? await lecturerSessions.findOne({ _id: hashToken(token), expires_at: { $gt: Date.now() } })
    : null

  if (!session) {
    if (token) await lecturerSessions.deleteOne({ _id: hashToken(token) })
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

async function sendStudentCancellationEmail({ student, email, matricNo, date, time }) {
  const transporter = createMailTransport()
  return transporter.sendMail({
    from: getMailFrom(),
    to: LECTURER.email,
    subject: 'Appointment cancelled by student',
    text: `A student cancelled their appointment.\n\nStudent: ${student}\nMatric number: ${matricNo}\nEmail: ${email}\nDate: ${date}\nTime: ${time}\n\nThe time is open for booking again.`,
  })
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
const lookupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 200 : 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
})
const sensitiveActionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100 : 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
})

app.get('/api/health', async (_req, res) => {
  try {
    await mongoDatabase.command({ ping: 1 })
    res.json({ status: 'ok', database: 'connected' })
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'disconnected' })
  }
})
app.get('/api/slots', async (req, res) => {
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
  const rows = await slots.find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, id: 1, date: 1, time: 1, duration: 1, status: 1, is_emergency: 1 } }).sort({ date: 1, time: 1 }).toArray()
  res.json(rows)
})
app.get('/api/slots/manage', requireLecturer, async (_req, res) => {
  res.json(recordsWithoutMongoIds(await slots.find().sort({ date: 1, time: 1 }).toArray()))
})
app.get('/api/analytics', requireLecturer, async (_req, res) => {
  const [total, booked, available, upcoming, todayAppointments, waitlistCount, funnel] = await Promise.all([
    slots.countDocuments(),
    slots.countDocuments({ status: 'booked' }),
    slots.countDocuments({ status: 'available' }),
    slots.find({ status: 'booked' }).sort({ date: 1, time: 1 }).limit(5).toArray(),
    slots.countDocuments({ status: 'booked', date: getLocalDateKey() }),
    waitlist.countDocuments({ status: 'waiting' }),
    funnelEvents.aggregate([{ $group: { _id: '$event', count: { $sum: 1 } } }]).toArray(),
  ])
  res.json({
    total,
    booked,
    available,
    todayAppointments,
    waitlistCount,
    funnel: Object.fromEntries(funnel.map(({ _id: event, count }) => [event, count])),
    upcoming: recordsWithoutMongoIds(upcoming),
  })
})
app.get('/api/bookings/history', requireLecturer, async (_req, res) => {
  const rows = await slots.find({ status: 'booked' }).sort({ date: -1, time: -1 }).limit(20).toArray()
  res.json(recordsWithoutMongoIds(rows))
})
app.get('/api/lecturer/status', async (_req, res) => {
  res.json({ hasPassword: Boolean(await lecturerAccounts.findOne({ _id: 1 }, { projection: { _id: 1 } })) })
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

  const isSetup = !await lecturerAccounts.findOne({ _id: 1 }, { projection: { _id: 1 } })
  const otp = generateOtp()
  const salt = randomUUID()
  await lecturerResetCodes.replaceOne({ _id: 1 }, {
    id: 1, code_hash: hashOtp(otp, salt), salt, expires_at: Date.now() + 10 * 60 * 1000, attempts: 0,
  }, { upsert: true })

  try {
    await sendLecturerResetEmail(otp, isSetup)
    return res.json(genericReply)
  } catch (error) {
    await lecturerResetCodes.deleteOne({ _id: 1 })
    console.error('Lecturer reset email failed:', error)
    return res.status(502).json({ error: 'Could not deliver the verification email. Check the SMTP settings and try again.' })
  }
})
app.post('/api/lecturer/password/set', otpVerifyRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
  const password = req.body?.password

  if (email !== normalizeEmail(LECTURER.email) || !/^\d{6}$/.test(code)) {
    return res.status(401).json({ error: 'The verification code is incorrect or has expired.' })
  }
  const problem = passwordProblem(password)
  if (problem) return res.status(400).json({ error: problem })

  const stored = await lecturerResetCodes.findOne({ _id: 1 })
  if (!stored || stored.expires_at < Date.now() || stored.attempts >= 5) {
    await lecturerResetCodes.deleteOne({ _id: 1 })
    return res.status(401).json({ error: 'The verification code is incorrect or has expired. Please request a new one.' })
  }
  if (hashOtp(code, stored.salt) !== stored.code_hash) {
    await lecturerResetCodes.updateOne({ _id: 1 }, { $inc: { attempts: 1 } })
    return res.status(401).json({ error: 'The verification code is incorrect or has expired.' })
  }

  const salt = randomBytes(16).toString('hex')
  const session = mongoClient.startSession()
  try {
    await session.withTransaction(async () => {
      await lecturerAccounts.replaceOne({ _id: 1 }, {
        id: 1, password_hash: hashPassword(password, salt), salt, updated_at: new Date().toISOString(),
      }, { upsert: true, session })
      await lecturerResetCodes.deleteOne({ _id: 1 }, { session })
      await lecturerSessions.deleteMany({}, { session })
    })
  } finally {
    await session.endSession()
  }
  res.json({ success: true, message: 'Your password has been saved. You can now sign in.' })
})
app.post('/api/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body || {}
  const account = await lecturerAccounts.findOne({ _id: 1 })

  if (!account) {
    return res.status(409).json({ error: 'Create your lecturer password first.', setupRequired: true })
  }
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256 || !email || !password || normalizeEmail(email) !== normalizeEmail(LECTURER.email) || !passwordMatches(password, account)) {
    return res.status(401).json({ error: 'Invalid lecturer credentials.' })
  }
  const token = randomUUID()
  const expiresAt = Date.now() + SESSION_TTL_MS
  await lecturerSessions.deleteMany({ expires_at: { $lte: Date.now() } })
  const tokenHash = hashToken(token)
  await lecturerSessions.insertOne({ _id: tokenHash, token_hash: tokenHash, expires_at: expiresAt, created_at: new Date().toISOString() })

  res.json({
    token,
    lecturer: { name: LECTURER.name, email: LECTURER.email },
  })
})
app.post('/api/logout', requireLecturer, async (req, res) => {
  const token = getTokenFromRequest(req)
  if (token) await lecturerSessions.deleteOne({ _id: hashToken(token) })
  res.json({ success: true })
})
app.get('/api/session', requireLecturer, (req, res) => {
  res.json({ lecturer: { name: req.lecturer.name, email: req.lecturer.email } })
})
app.post('/api/slots', requireLecturer, async (req, res) => {
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
    const session = mongoClient.startSession()
    let result
    try {
      await session.withTransaction(async () => {
        await slotDateLocks.updateOne({ _id: date }, { $inc: { version: 1 } }, { upsert: true, session })
        const existingSlots = await slots.find({ date }, { projection: { time: 1, duration: 1, status: 1, _id: 0 } }).toArray()
        const newStart = timeToMinutes(time)
        const overlap = existingSlots.find((slot) => {
          const existingStart = timeToMinutes(slot.time)
          return newStart < existingStart + slot.duration && existingStart < newStart + slotDuration
        })
        if (overlap) {
          result = { overlap }
          return
        }

        const slot = {
          id, date, time, duration: slotDuration, status: 'available',
          student: null, email: null, matric_no: null, level: null, department: null, topic: null,
          is_emergency: emergencyMode ? 1 : 0, attendance: null, last_reminder_at: null,
          created_at: new Date().toISOString(),
        }
        await slots.insertOne(slot, { session })
        result = { slot }
      })
    } finally {
      await session.endSession()
    }
    if (result.overlap) {
      if (result.overlap.time === time) {
        return res.status(409).json({ error: `A ${result.overlap.status} slot already exists at that date and time.` })
      }
      return res.status(409).json({
        error: `This time overlaps the ${result.overlap.status} slot at ${result.overlap.time}. Choose a non-overlapping time.`,
      })
    }
    res.status(201).json(recordWithoutMongoId(result.slot))
  } catch (error) {
    console.error('Create slot failed:', error)
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A slot already exists at that date and time.' })
    }
    res.status(500).json({ error: 'Could not create the slot. Please try again.' })
  }
})
app.delete('/api/slots/:id', requireLecturer, async (req, res) => {
  const result = await slots.deleteOne({ id: req.params.id, status: 'available' })
  if (!result.deletedCount) return res.status(404).json({ error: 'Available slot not found.' })
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
  await emailOtps.replaceOne({ _id: email }, {
    email, code_hash: hashOtp(otp, salt), salt, expires_at: expiresAt,
    verified: 0, attempts: 0, created_at: Date.now(),
  }, { upsert: true })

  try {
    await sendOtpEmail(email, otp, studentName)
    return res.json({ success: true, message: 'Verification code sent to your email. Check your inbox and spam folder.' })
  } catch (error) {
    await emailOtps.deleteOne({ _id: email })
    console.error('OTP send failed:', error)
    return res.status(502).json({ error: 'Could not deliver the verification email. Check the SMTP settings and try again.' })
  }
})

app.post('/api/email/otp/verify', otpVerifyRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : ''

  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'Enter a valid email address and six-digit OTP.' })
  }

  const stored = await emailOtps.findOne({ _id: email })
  if (!stored || stored.expires_at < Date.now()) {
    await emailOtps.deleteOne({ _id: email })
    return res.status(401).json({ error: 'Your verification code has expired. Please request a new one.' })
  }

  if (stored.attempts >= 5) {
    await emailOtps.deleteOne({ _id: email })
    return res.status(429).json({ error: 'Too many incorrect codes. Please request a new one.' })
  }

  if (hashOtp(otp, stored.salt) !== stored.code_hash) {
    const attempts = stored.attempts + 1
    if (attempts >= 5) await emailOtps.deleteOne({ _id: email })
    else await emailOtps.updateOne({ _id: email }, { $set: { attempts } })
    return res.status(401).json({ error: 'The OTP is incorrect.' })
  }

  await emailOtps.updateOne({ _id: email }, { $set: { verified: 1, expires_at: Date.now() + VERIFIED_TTL_MS } })
  const verifiedUntil = Date.now() + VERIFIED_TTL_MS
  return res.json({ success: true, message: 'Email verified successfully.', verifiedUntil })
})

app.post('/api/analytics/events', async (req, res) => {
  const { event } = req.body || {}
  const allowedEvents = new Set(['booking_page_view', 'otp_requested', 'email_verified', 'slot_selected', 'booking_confirmed'])
  if (typeof event !== 'string' || !allowedEvents.has(event)) {
    return res.status(400).json({ error: 'Choose a supported analytics event.' })
  }
  const now = new Date()
  await funnelEvents.insertOne({ id: randomUUID(), event, created_at: now.toISOString() })
  await funnelEvents.deleteMany({ created_at: { $lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString() } })
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

  const slot = await slots.findOne({ id: slotId })
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

  const verifiedRecord = await emailOtps.findOne({ _id: normalizedEmail })
  if (!verifiedRecord || verifiedRecord.expires_at < Date.now() || !verifiedRecord.verified) {
    return res.status(401).json({ error: 'Verify your email before booking.' })
  }

  if (!/^\d{6}$/.test(normalizedOtp) || hashOtp(normalizedOtp, verifiedRecord.salt) !== verifiedRecord.code_hash) {
    return res.status(401).json({ error: 'The OTP does not match the verified email.' })
  }

  const matricKey = normalizedMatricNo.replace(/[\s/.\-]+/g, '').toUpperCase()
  const lockIds = [`email:${hashToken(canonicalEmail(normalizedEmail))}`, `matric:${hashToken(matricKey)}`].sort()
  for (const lockId of lockIds) {
    try {
      await bookingLocks.updateOne({ _id: lockId }, { $inc: { version: 1 } }, { upsert: true })
    } catch (error) {
      if (error.code !== 11000) throw error
      await bookingLocks.updateOne({ _id: lockId }, { $inc: { version: 1 } })
    }
  }
  const session = mongoClient.startSession()
  let bookingResult
  try {
    await session.withTransaction(async () => {
      for (const lockId of lockIds) await bookingLocks.updateOne({ _id: lockId }, { $inc: { version: 1 } }, { session })
      const emailKey = canonicalEmail(normalizedEmail)
      const existingBooking = (await slots.find({ status: 'booked', date: { $gte: getLocalDateKey() } }, {
        projection: { _id: 0, id: 1, date: 1, time: 1, email: 1, matric_no: 1 }, session,
      }).toArray()).find((row) => canonicalEmail(row.email) === emailKey || (matricKey && String(row.matric_no || '').replace(/[\s/.\-]+/g, '').toUpperCase() === matricKey))
      if (existingBooking) {
        bookingResult = { conflict: 'already_booked', existingBooking }
        return
      }

      const result = await slots.updateOne({ id: slotId, status: 'available' }, { $set: {
        status: 'booked', student: normalizedStudent, email: normalizedEmail,
        matric_no: normalizedMatricNo, level: normalizedLevel,
        department: normalizedDepartment, topic: normalizedTopic,
      } }, { session })
      if (!result.modifiedCount) {
        bookingResult = { conflict: 'slot_unavailable' }
        return
      }

      bookingResult = { bookedSlot: await slots.findOne({ id: slotId }, { session }) }
    })
  } finally {
    await session.endSession()
  }

  if (bookingResult.conflict === 'already_booked') {
    return res.status(409).json({
      error: 'You already have an upcoming appointment. Only one booking is allowed per student at a time. Please attend it or ask the lecturer to cancel it first.',
      existingBooking: bookingResult.existingBooking,
    })
  }
  if (bookingResult.conflict === 'slot_unavailable') {
    return res.status(409).json({ error: 'That appointment is no longer available.' })
  }

  const bookedSlot = recordWithoutMongoId(bookingResult.bookedSlot)
  await emailOtps.deleteOne({ _id: normalizedEmail })

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
async function checkVerifiedStudent(emailInput, otpInput) {
  const email = normalizeEmail(emailInput)
  const otp = typeof otpInput === 'string' ? otpInput.trim() : ''
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return { status: 400, error: 'Enter a valid email address.' }
  }
  const record = await emailOtps.findOne({ _id: email })
  if (!record || record.expires_at < Date.now() || !record.verified) {
    return { status: 401, error: 'Verify your email first.' }
  }
  if (!/^\d{6}$/.test(otp) || hashOtp(otp, record.salt) !== record.code_hash) {
    return { status: 401, error: 'The OTP does not match the verified email.' }
  }
  return { email }
}

app.post('/api/bookings/mine', lookupRateLimit, async (req, res) => {
  const check = await checkVerifiedStudent(req.body?.email, req.body?.otp)
  if (check.error) return res.status(check.status).json({ error: check.error })

  const key = canonicalEmail(check.email)
  const bookings = (await slots.find({ status: 'booked', date: { $gte: getLocalDateKey() } }, {
    projection: { _id: 0, id: 1, date: 1, time: 1, duration: 1, topic: 1, student: 1, matric_no: 1, email: 1 },
  }).sort({ date: 1, time: 1 }).toArray())
    .filter((row) => canonicalEmail(row.email) === key)
    .map(({ matric_no: matricNo, email: _email, ...rest }) => ({ ...rest, matricNo }))
  res.json({ bookings })
})

app.post('/api/bookings/mine/cancel', lookupRateLimit, async (req, res) => {
  const check = await checkVerifiedStudent(req.body?.email, req.body?.otp)
  if (check.error) return res.status(check.status).json({ error: check.error })

  const slotId = req.body?.slotId
  if (typeof slotId !== 'string' || !slotId || slotId.length > 64) {
    return res.status(400).json({ error: 'Choose an appointment to cancel.' })
  }

  const slot = await slots.findOne({ id: slotId, status: 'booked' })
  if (!slot || canonicalEmail(slot.email) !== canonicalEmail(check.email)) {
    return res.status(404).json({ error: 'That appointment could not be found.' })
  }

  const result = await slots.updateOne({ id: slotId, status: 'booked' }, { $set: {
    status: 'available', student: null, email: null, matric_no: null, level: null,
    department: null, topic: null, attendance: null,
  } })
  if (!result.modifiedCount) return res.status(404).json({ error: 'That appointment could not be found.' })

  try {
    await sendStudentCancellationEmail({ student: slot.student, email: slot.email, matricNo: slot.matric_no, date: slot.date, time: slot.time })
  } catch (error) {
    console.error('Cancellation notice failed:', error)
  }

  const waitlistEntry = await waitlist.findOneAndUpdate(
    { date: slot.date, status: 'waiting' },
    { $set: { status: 'notified' } },
    { sort: { created_at: 1 }, returnDocument: 'after' },
  )
  if (waitlistEntry) {
    try {
      await sendWaitlistNotificationEmail({ student: waitlistEntry.student, email: waitlistEntry.email, date: waitlistEntry.date, time: slot.time })
    } catch (error) {
      console.error('Waitlist notification failed:', error)
    }
  }

  res.json({ success: true, message: 'Your appointment has been cancelled.' })
})

app.get('/api/bookings/all', requireLecturer, async (_req, res) => {
  const rows = await slots.find({ status: 'booked' }).sort({ date: -1, time: -1 }).limit(5000).toArray()
  res.json(recordsWithoutMongoIds(rows))
})
app.post('/api/bookings/:id/attendance', requireLecturer, async (req, res) => {
  const status = req.body?.status
  if (!['attended', 'no_show', 'clear'].includes(status)) {
    return res.status(400).json({ error: 'Choose attended, no-show, or clear.' })
  }

  const slot = await slots.findOne({ id: req.params.id, status: 'booked' })
  if (!slot) return res.status(404).json({ error: 'Booking not found.' })
  if (slot.date > getLocalDateKey()) {
    return res.status(400).json({ error: 'Attendance can only be marked on or after the appointment day.' })
  }

  await slots.updateOne({ id: slot.id }, { $set: { attendance: status === 'clear' ? null : status } })
  res.json(recordWithoutMongoId(await slots.findOne({ id: slot.id })))
})
app.delete('/api/bookings/:id', requireLecturer, async (req, res) => {
  const cancelledSlot = await slots.findOne({ id: req.params.id, status: 'booked' })
  if (!cancelledSlot) return res.status(404).json({ error: 'Booking not found.' })

  const result = await slots.updateOne({ id: req.params.id, status: 'booked' }, { $set: {
    status: 'available', student: null, email: null, matric_no: null, level: null,
    department: null, topic: null, attendance: null,
  } })
  if (!result.modifiedCount) return res.status(404).json({ error: 'Booking not found.' })

  const waitlistEntry = await waitlist.findOneAndUpdate(
    { date: cancelledSlot.date, status: 'waiting' },
    { $set: { status: 'notified' } },
    { sort: { created_at: 1 }, returnDocument: 'after' },
  )
  if (waitlistEntry) {
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
app.post('/api/waitlist', sensitiveActionRateLimit, async (req, res) => {
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

  const verification = await emailOtps.findOne({ _id: normalizedEmail })
  if (!verification || verification.expires_at < Date.now() || !verification.verified) {
    return res.status(401).json({ error: 'Verify your email before joining the waitlist.' })
  }
  if (!/^\d{6}$/.test(normalizedOtp) || hashOtp(normalizedOtp, verification.salt) !== verification.code_hash) {
    return res.status(401).json({ error: 'The OTP does not match the verified email.' })
  }

  const existing = await waitlist.findOne({ date, email: normalizedEmail, status: 'waiting' })
  if (existing) {
    return res.status(409).json({ error: 'You are already on the waitlist for this date.' })
  }

  const id = randomUUID()
  try {
    await waitlist.insertOne({
      id, date, student: normalizedName, email: normalizedEmail, topic: normalizedTopic,
      urgency, status: 'waiting', created_at: new Date().toISOString(),
    })
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'You are already on the waitlist for this date.' })
    throw error
  }
  await emailOtps.deleteOne({ _id: normalizedEmail })
  res.status(201).json({ id, date, student: normalizedName, email: normalizedEmail, urgency })
})
app.get('/api/waitlist', requireLecturer, async (_req, res) => {
  const rows = await waitlist.find({ status: 'waiting' }).sort({ date: 1, created_at: 1 }).toArray()
  res.json(recordsWithoutMongoIds(rows))
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
    ? await slots.findOne({ id: recipientId, status: 'booked' }, { projection: { _id: 0, id: 1, student: 1, email: 1, date: 1, time: 1 } })
    : await waitlist.findOne({ id: recipientId, status: 'waiting' }, { projection: { _id: 0, id: 1, student: 1, email: 1, date: 1 } })
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
app.delete('/api/waitlist/:id', requireLecturer, async (req, res) => {
  const result = await waitlist.updateOne({ id: req.params.id, status: 'waiting' }, { $set: { status: 'removed' } })
  if (!result.modifiedCount) return res.status(404).json({ error: 'Waitlist request not found.' })
  res.status(204).end()
})
app.get('/api/bookings', requireLecturer, async (_req, res) => {
  const rows = await slots.find({ status: 'booked' }).sort({ date: 1, time: 1 }).toArray()
  res.json(recordsWithoutMongoIds(rows))
})
app.post('/api/email/reminders/send', sensitiveActionRateLimit, requireLecturer, async (_req, res) => {
  const today = getLocalDateKey()
  const upcoming = await slots.find({ status: 'booked', date: { $gte: today } }).sort({ date: 1, time: 1 }).toArray()
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
app.get('/api/stats', async (_req, res) => {
  const [total, booked, available, nextBooking] = await Promise.all([
    slots.countDocuments(),
    slots.countDocuments({ status: 'booked' }),
    slots.countDocuments({ status: 'available' }),
    slots.findOne({ status: 'booked' }, { projection: { _id: 0, id: 1, date: 1, time: 1, duration: 1 }, sort: { date: 1, time: 1 } }),
  ])
  res.json({
    total,
    booked,
    available,
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

export { app, mongoClient, mongoDatabase }
