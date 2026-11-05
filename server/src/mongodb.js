import { MongoClient } from 'mongodb'

export const COLLECTION_NAMES = Object.freeze({
  slots: 'slots',
  waitlist: 'waitlist',
  lecturerAccounts: 'lecturer_accounts',
  lecturerResetCodes: 'lecturer_reset_codes',
  lecturerSessions: 'lecturer_sessions',
  emailOtps: 'email_otps',
  funnelEvents: 'funnel_events',
  bookingLocks: 'booking_locks',
  slotDateLocks: 'slot_date_locks',
})

export function getMongoCollections(database) {
  return Object.fromEntries(
    Object.entries(COLLECTION_NAMES).map(([key, name]) => [key, database.collection(name)]),
  )
}

export async function connectMongo({ uri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DB_NAME || 'office_hours' } = {}) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('MONGODB_URI is required to connect to MongoDB.')
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 })
  try {
    await client.connect()
    const database = client.db(databaseName)
    const collections = getMongoCollections(database)

    await Promise.all([
      collections.slots.createIndex({ date: 1, time: 1 }, { unique: true, name: 'unique_slot_time' }),
      collections.slots.createIndex({ status: 1, date: 1, time: 1 }, { name: 'slots_status_date_time' }),
      collections.slots.createIndex({ status: 1, email: 1, date: 1 }, { name: 'slots_student_bookings' }),
      collections.waitlist.createIndex(
        { date: 1, email: 1 },
        {
          unique: true,
          name: 'unique_active_waitlist_email_date',
          partialFilterExpression: { status: 'waiting' },
        },
      ),
      collections.waitlist.createIndex({ date: 1, status: 1, created_at: 1 }, { name: 'waitlist_handoff_order' }),
      collections.lecturerSessions.createIndex({ expires_at: 1 }, { name: 'session_expiry' }),
      collections.emailOtps.createIndex({ expires_at: 1 }, { name: 'otp_expiry' }),
      collections.funnelEvents.createIndex({ created_at: 1 }, { name: 'funnel_event_retention' }),
    ])

    return { client, database, collections }
  } catch (error) {
    await client.close()
    throw error
  }
}
