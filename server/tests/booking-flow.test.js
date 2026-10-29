import test from 'node:test'
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import supertest from 'supertest'
import Database from 'better-sqlite3'

process.env.APPOINTMENTS_DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.LECTURER_EMAIL = 'lecturer@example.edu'
const sentEmails = []
let smtpServer
let authLoginStep = 0

smtpServer = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.write('220 localhost ESMTP\r\n')
  let buffer = ''
  let isReadingMessage = false
  let messageChunks = []

  socket.on('data', (chunk) => {
    buffer += chunk

    while (buffer.length) {
      if (isReadingMessage) {
        const endOfMessage = buffer.indexOf('\r\n.\r\n')
        if (endOfMessage === -1) {
          messageChunks.push(buffer)
          buffer = ''
          return
        }

        messageChunks.push(buffer.slice(0, endOfMessage))
        sentEmails.push(messageChunks.join(''))
        messageChunks = []
        buffer = buffer.slice(endOfMessage + 5)
        isReadingMessage = false
        socket.write('250 Message accepted\r\n')
        continue
      }

      const lineEnd = buffer.indexOf('\r\n')
      if (lineEnd === -1) return
      const line = buffer.slice(0, lineEnd)
      buffer = buffer.slice(lineEnd + 2)
      const command = line.toUpperCase()

      if (command.startsWith('EHLO') || command.startsWith('HELO')) {
        socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n')
      } else if (command.startsWith('AUTH PLAIN')) {
        socket.write('235 Authentication successful\r\n')
      } else if (command === 'AUTH LOGIN') {
        authLoginStep = 1
        socket.write('334 VXNlcm5hbWU6\r\n')
      } else if (authLoginStep === 1) {
        authLoginStep = 2
        socket.write('334 UGFzc3dvcmQ6\r\n')
      } else if (authLoginStep === 2) {
        authLoginStep = 0
        socket.write('235 Authentication successful\r\n')
      } else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO')) {
        socket.write('250 OK\r\n')
      } else if (command === 'DATA') {
        isReadingMessage = true
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
      } else if (command === 'QUIT') {
        socket.end('221 Bye\r\n')
      } else {
        socket.write('250 OK\r\n')
      }
    }
  })
})

await new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
process.env.SMTP_HOST = '127.0.0.1'
process.env.SMTP_PORT = String(smtpServer.address().port)
process.env.SMTP_USER = 'test-user'
process.env.SMTP_PASS = 'test-password'

const { app } = await import('../src/index.js')
const request = supertest(app)
after(() => new Promise((resolve) => smtpServer.close(resolve)))

test('database backup can be restored and queried', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'appointment-restore-'))
  const sourcePath = path.join(directory, 'source.db')
  const backupPath = path.join(directory, 'backup.db')
  const source = new Database(sourcePath)
  source.exec('CREATE TABLE restore_check (value TEXT NOT NULL); INSERT INTO restore_check VALUES (\'restored successfully\');')

  try {
    await source.backup(backupPath)
  } finally {
    source.close()
  }

  const restored = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    assert.equal(restored.prepare('SELECT value FROM restore_check').get().value, 'restored successfully')
  } finally {
    restored.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const getOtpFromEmail = (email) => {
  const sentEmail = [...sentEmails].reverse().find((message) => message.toLowerCase().includes(email.toLowerCase()))
  assert.ok(sentEmail, `Expected an email to be sent to ${email}`)
  const otpMatch = sentEmail.match(/\b(\d{6})\b/)
  assert.ok(otpMatch, `Expected the sent email to contain a six-digit OTP. Message: ${sentEmail}`)
  return otpMatch[1]
}

const lecturerEmail = process.env.LECTURER_EMAIL
const lecturerPassword = 'Test-only-password-123'

const ensureLecturerPassword = async () => {
  const status = await request.get('/api/lecturer/status')
  if (status.body.hasPassword) return
  const codeRequest = await request.post('/api/lecturer/password/request-code').send({ email: lecturerEmail })
  assert.equal(codeRequest.status, 200)
  const set = await request.post('/api/lecturer/password/set').send({ email: lecturerEmail, code: getOtpFromEmail(lecturerEmail), password: lecturerPassword })
  assert.equal(set.status, 200)
}

const getLecturerToken = async () => {
  await ensureLecturerPassword()
  const login = await request.post('/api/login').send({ email: lecturerEmail, password: lecturerPassword })
  assert.equal(login.status, 200)
  return login.body.token
}

test('OTP is delivered by email and is not returned by the API', async () => {
  const email = 'student.test@example.com'

  const otpRequest = await request.post('/api/email/otp/request').send({ email })
  assert.equal(otpRequest.status, 200)
  assert.equal(otpRequest.body.debugCode, undefined)
  assert.match(otpRequest.body.message, /sent to your email/i)

  const otpVerification = await request.post('/api/email/otp/verify').send({
    email,
    otp: getOtpFromEmail(email),
  })

  assert.equal(otpVerification.status, 200)
  assert.equal(otpVerification.body.success, true)
})

test('lecturer must create a password first, can sign in, and can reset it by email code', async () => {
  const beforeSetup = await request.post('/api/login').send({ email: lecturerEmail, password: 'anything-at-all-1' })
  if (beforeSetup.status === 409) assert.equal(beforeSetup.body.setupRequired, true)

  await ensureLecturerPassword()

  const weak = await request.post('/api/lecturer/password/request-code').send({ email: lecturerEmail })
  assert.equal(weak.status, 200)
  const weakSet = await request.post('/api/lecturer/password/set').send({ email: lecturerEmail, code: getOtpFromEmail(lecturerEmail), password: 'short1' })
  assert.equal(weakSet.status, 400)

  const wrongCode = await request.post('/api/lecturer/password/set').send({ email: lecturerEmail, code: '000000', password: 'New-password-456' })
  assert.equal(wrongCode.status, 401)

  const strangerRequest = await request.post('/api/lecturer/password/request-code').send({ email: 'stranger@example.com' })
  assert.equal(strangerRequest.status, 200)
  assert.ok(![...sentEmails].some((message) => message.toLowerCase().includes('to: stranger@example.com') && /reset your lecturer password/i.test(message)))

  const reset = await request.post('/api/lecturer/password/request-code').send({ email: lecturerEmail })
  assert.equal(reset.status, 200)
  const resetSet = await request.post('/api/lecturer/password/set').send({ email: lecturerEmail, code: getOtpFromEmail(lecturerEmail), password: 'New-password-456' })
  assert.equal(resetSet.status, 200)

  const oldPassword = await request.post('/api/login').send({ email: lecturerEmail, password: lecturerPassword })
  assert.equal(oldPassword.status, 401)
  const newPassword = await request.post('/api/login').send({ email: lecturerEmail, password: 'New-password-456' })
  assert.equal(newPassword.status, 200)

  // restore the shared test password for the other tests
  const restoreRequest = await request.post('/api/lecturer/password/request-code').send({ email: lecturerEmail })
  assert.equal(restoreRequest.status, 200)
  const restore = await request.post('/api/lecturer/password/set').send({ email: lecturerEmail, code: getOtpFromEmail(lecturerEmail), password: lecturerPassword })
  assert.equal(restore.status, 200)
})

test('lecturer signs in with configured email and password', async () => {
  await ensureLecturerPassword()
  const invalidLogin = await request.post('/api/login').send({ email: lecturerEmail, password: 'wrong-password' })
  assert.equal(invalidLogin.status, 401)

  const validLogin = await request.post('/api/login').send({ email: lecturerEmail, password: lecturerPassword })
  assert.equal(validLogin.status, 200)
  assert.ok(validLogin.body.token)
  assert.equal(validLogin.body.lecturer.email, lecturerEmail)
})

test('OTP is never exposed in development, even if debug mode is enabled', async () => {
  const previous = process.env.SHOW_OTP_DEBUG
  process.env.SHOW_OTP_DEBUG = 'true'

  const email = 'smtp.debug@example.com'
  const otpRequest = await request.post('/api/email/otp/request').send({ email, student: 'Debug User' })

  if (previous === undefined) delete process.env.SHOW_OTP_DEBUG
  else process.env.SHOW_OTP_DEBUG = previous

  assert.equal(otpRequest.status, 200)
  assert.equal(otpRequest.body.debugCode, undefined)
  const verification = await request.post('/api/email/otp/verify').send({ email, otp: getOtpFromEmail(email) })
  assert.equal(verification.status, 200)
})

test('OTP request fails clearly when SMTP is not configured', async () => {
  const previousHost = process.env.SMTP_HOST
  process.env.SMTP_HOST = ''

  const response = await request.post('/api/email/otp/request').send({ email: 'no.smtp@example.com' })

  process.env.SMTP_HOST = previousHost
  assert.equal(response.status, 503)
  assert.match(response.body.error, /email delivery is not configured/i)
  assert.equal(response.body.debugCode, undefined)
})

test('public slot listing never returns student personal data', async () => {
  const token = await getLecturerToken()
  const date = new Date()
  date.setDate(date.getDate() + 12)
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const slot = await request.post('/api/slots').set('Authorization', `Bearer ${token}`).send({ date: dateKey, time: '12:00' })
  assert.equal(slot.status, 201)

  const email = 'private.student@example.com'
  const otpRequest = await request.post('/api/email/otp/request').send({ email })
  const otp = getOtpFromEmail(email)
  await request.post('/api/email/otp/verify').send({ email, otp })
  await request.post('/api/bookings').send({
    slotId: slot.body.id,
    student: 'Private Student',
    email,
    matricNo: '2024/000001',
    level: '300 level',
    department: 'Computer Science',
    topic: 'Private topic',
    otp,
  })

  const publicSlots = await request.get('/api/slots')
  assert.equal(otpRequest.status, 200)
  assert.equal(publicSlots.status, 200)
  assert.equal(JSON.stringify(publicSlots.body).includes(email), false)
  assert.equal(JSON.stringify(publicSlots.body).includes('Private Student'), false)
  assert.equal(JSON.stringify(publicSlots.body).includes('2024/000001'), false)
  assert.equal(JSON.stringify(publicSlots.body).includes('Private topic'), false)

  const privateSlotsWithoutAuth = await request.get('/api/slots/manage')
  assert.equal(privateSlotsWithoutAuth.status, 401)
})

test('unknown API routes return a generic JSON 404', async () => {
  const response = await request.get('/api/not-a-route')
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'API endpoint not found.' })
  assert.equal(JSON.stringify(response.body).includes('stack'), false)
})

test('all lecturer data and mutation routes reject unauthenticated requests', async () => {
  const protectedRequests = [
    request.get('/api/slots/manage'),
    request.get('/api/analytics'),
    request.get('/api/bookings/history'),
    request.get('/api/session'),
    request.get('/api/bookings'),
    request.get('/api/waitlist'),
    request.post('/api/slots').send({ date: '2027-01-01', time: '09:00' }),
    request.post('/api/logout'),
    request.delete('/api/slots/unknown'),
    request.delete('/api/bookings/unknown'),
    request.delete('/api/waitlist/unknown'),
    request.post('/api/attendance-notices').send({ recipientType: 'booking', recipientId: 'unknown', shouldAttend: true }),
    request.post('/api/email/reminders/send'),
  ]
  const responses = await Promise.all(protectedRequests)
  assert.deepEqual(responses.map(({ status }) => status), Array(protectedRequests.length).fill(401))
  for (const response of responses) {
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(JSON.stringify(response.body).includes('stack'), false)
  }
})

test('slot listing rejects malformed ranges instead of scanning all records', async () => {
  const response = await request.get('/api/slots?from[]=2027-01-01&to=2027-01-02')
  assert.equal(response.status, 400)
  assert.deepEqual(response.body, { error: 'Choose a valid appointment date range.' })
})

test('booking input rejects non-string personal data and malformed OTPs', async () => {
  const response = await request.post('/api/bookings').send({
    slotId: { unexpected: 'object' },
    student: { unexpected: 'object' },
    email: 'student@example.com',
  })
  assert.equal(response.status, 400)
  assert.equal(JSON.stringify(response.body).includes('stack'), false)
})

test('lecturer cannot create a slot in the past', async () => {
  const token = await getLecturerToken()
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const response = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send({ date: pastDate, time: '09:00' })

  assert.equal(response.status, 400)
  assert.match(response.body.error, /past/i)
})

test('lecturer receives a clear conflict when adding the same date and time twice', async () => {
  const token = await getLecturerToken()
  const date = new Date()
  date.setDate(date.getDate() + 10)
  const slotDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const slotDetails = { date: slotDate, time: '12:45', duration: 30 }

  const firstSlot = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send(slotDetails)
  assert.equal(firstSlot.status, 201)

  const duplicateSlot = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send(slotDetails)

  assert.equal(duplicateSlot.status, 409)
  assert.match(duplicateSlot.body.error, /already exists/i)
  assert.match(duplicateSlot.body.error, /available/i)
})

test('a student can book only once per day but may book on another day', async () => {
  const token = await getLecturerToken()
  const email = 'booked.student@example.com'
  const date = new Date()
  date.setDate(date.getDate() + 5)
  const bookingDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const anotherDate = new Date(date)
  anotherDate.setDate(anotherDate.getDate() + 1)
  const anotherBookingDate = `${anotherDate.getFullYear()}-${String(anotherDate.getMonth() + 1).padStart(2, '0')}-${String(anotherDate.getDate()).padStart(2, '0')}`

  const otpRequest = await request.post('/api/email/otp/request').send({ email })
  const otp = getOtpFromEmail(email)

  const otpVerification = await request.post('/api/email/otp/verify').send({ email, otp })
  assert.equal(otpVerification.status, 200)

  const firstSlot = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send({ date: bookingDate, time: '10:30', duration: 30 })

  const secondSlot = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send({ date: bookingDate, time: '11:00', duration: 30 })

  const differentDaySlot = await request.post('/api/slots')
    .set('Authorization', `Bearer ${token}`)
    .send({ date: anotherBookingDate, time: '11:30', duration: 30 })

  assert.equal(firstSlot.status, 201)
  assert.equal(secondSlot.status, 201)
  assert.equal(differentDaySlot.status, 201)

  const bookingResponse = await request.post('/api/bookings').send({
    slotId: firstSlot.body.id,
    student: 'Fiona Mills',
    email,
    matricNo: '2024/123456',
    level: '300 level',
    department: 'Computer Science',
    otp,
    topic: 'Project guidance',
  })

  assert.equal(bookingResponse.status, 201)
  assert.equal(bookingResponse.body.confirmation.email, email)
  assert.equal(bookingResponse.body.emailDelivery.lecturerNotification, true)
  assert.equal(bookingResponse.body.emailDelivery.studentConfirmation, true)
  assert.equal(bookingResponse.body.matric_no, '2024/123456')
  assert.equal(bookingResponse.body.level, '300 level')
  assert.equal(bookingResponse.body.department, 'Computer Science')

  const mailCountBeforeNotices = sentEmails.length
  const bookingNotice = await request.post('/api/attendance-notices')
    .set('Authorization', `Bearer ${token}`)
    .send({ recipientType: 'booking', recipientId: firstSlot.body.id, shouldAttend: true })
  assert.equal(bookingNotice.status, 200)
  assert.equal(sentEmails.length, mailCountBeforeNotices + 1)

  const waitlistEmail = 'waitlisted.student@example.com'
  const waitlistOtpRequest = await request.post('/api/email/otp/request').send({ email: waitlistEmail })
  const waitlistOtp = getOtpFromEmail(waitlistEmail)
  const waitlistOtpVerification = await request.post('/api/email/otp/verify').send({ email: waitlistEmail, otp: waitlistOtp })
  assert.equal(waitlistOtpRequest.status, 200)
  assert.equal(waitlistOtpVerification.status, 200)

  const waitlistRequest = await request.post('/api/waitlist').send({
    date: anotherBookingDate,
    student: 'Waitlisted Student',
    email: waitlistEmail,
    topic: 'Urgent help',
    otp: waitlistOtp,
  })
  assert.equal(waitlistRequest.status, 201)

  const mailCountBeforeWaitlistNotice = sentEmails.length
  const waitlistNotice = await request.post('/api/attendance-notices')
    .set('Authorization', `Bearer ${token}`)
    .send({ recipientType: 'waitlist', recipientId: waitlistRequest.body.id, shouldAttend: false })
  assert.equal(waitlistNotice.status, 200)
  assert.equal(sentEmails.length, mailCountBeforeWaitlistNotice + 1)

  const nextOtpRequest = await request.post('/api/email/otp/request').send({ email: email.toUpperCase() })
  const nextOtp = getOtpFromEmail(email)
  const nextOtpVerification = await request.post('/api/email/otp/verify').send({ email, otp: nextOtp })
  assert.equal(nextOtpVerification.status, 200)

  const duplicateBookingResponse = await request.post('/api/bookings').send({
    slotId: secondSlot.body.id,
    student: 'Fiona Mills',
    email: email.toUpperCase(),
    matricNo: '2024/123456',
    level: '300 level',
    department: 'Computer Science',
    otp: nextOtp,
    topic: 'Another appointment',
  })

  assert.equal(duplicateBookingResponse.status, 409)
  assert.match(duplicateBookingResponse.body.error, /already have an upcoming appointment/i)

  const differentDayBookingResponse = await request.post('/api/bookings').send({
    slotId: differentDaySlot.body.id,
    student: 'Fiona Mills',
    email: email.toUpperCase(),
    matricNo: '2024/123456',
    level: '300 level',
    department: 'Computer Science',
    otp: nextOtp,
    topic: 'Another day project guidance',
  })

  assert.equal(differentDayBookingResponse.status, 409)
})
