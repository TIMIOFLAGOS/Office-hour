import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import dotenv from 'dotenv'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(serverDirectory, '.env') })

const sourceValue = process.env.APPOINTMENTS_DB_PATH || path.join(serverDirectory, 'appointments.db')
if (sourceValue === ':memory:') {
  throw new Error('Restore checks require a file-backed SQLite database.')
}
const sourcePath = path.isAbsolute(sourceValue) ? sourceValue : path.resolve(serverDirectory, sourceValue)
const backupPath = process.argv[2]
if (!backupPath) {
  throw new Error('Usage: npm run restore:check -- <backup-file>')
}
const resolvedBackupPath = path.resolve(backupPath)

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'appointments-restore-check-'))
const restoredPath = path.join(temporaryDirectory, 'restored.db')
let source
let backup
let restored

try {
  source = new Database(sourcePath, { fileMustExist: true, readonly: true })
  backup = new Database(resolvedBackupPath, { fileMustExist: true, readonly: true })
  const sourceIntegrity = source.pragma('integrity_check', { simple: true })
  const backupIntegrity = backup.pragma('integrity_check', { simple: true })
  if (sourceIntegrity !== 'ok' || backupIntegrity !== 'ok') {
    throw new Error('Source or backup failed SQLite integrity_check.')
  }

  const sourceTables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
  const backupTables = backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
  if (JSON.stringify(sourceTables) !== JSON.stringify(backupTables)) {
    throw new Error('Backup table set differs from the live database.')
  }
  for (const table of sourceTables) {
    const expectedCount = source.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count
    const actualCount = backup.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count
    if (expectedCount !== actualCount) {
      throw new Error(`Backup row count differs for table ${table}.`)
    }
  }

  await backup.backup(restoredPath)
  restored = new Database(restoredPath, { readonly: true })
  if (restored.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('Restored database failed SQLite integrity_check.')
  }
  const restoredTables = restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
  if (JSON.stringify(sourceTables) !== JSON.stringify(restoredTables)) {
    throw new Error('Restored database schema does not match the source.')
  }
  for (const table of sourceTables) {
    const expectedCount = source.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count
    const restoredCount = restored.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count
    if (expectedCount !== restoredCount) {
      throw new Error(`Restored row count differs for table ${table}.`)
    }
  }
  console.log('Backup integrity and isolated restore check passed; table names and row counts match the live database.')
} finally {
  restored?.close()
  backup?.close()
  source?.close()
  await rm(temporaryDirectory, { recursive: true, force: true })
}
