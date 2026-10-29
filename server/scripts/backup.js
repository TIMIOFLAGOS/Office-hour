import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import dotenv from 'dotenv'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(serverDirectory, '.env') })

const configuredDatabase = process.env.APPOINTMENTS_DB_PATH || path.join(serverDirectory, 'appointments.db')
if (configuredDatabase === ':memory:') {
  throw new Error('Backups require a file-backed SQLite database.')
}
const sourcePath = path.isAbsolute(configuredDatabase)
  ? configuredDatabase
  : path.resolve(serverDirectory, configuredDatabase)
const configuredBackup = process.env.APPOINTMENTS_BACKUP_PATH
const backupDirectory = configuredBackup
  ? path.dirname(path.isAbsolute(configuredBackup) ? configuredBackup : path.resolve(serverDirectory, configuredBackup))
  : path.join(serverDirectory, 'backups')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const destinationPath = configuredBackup
  ? (path.isAbsolute(configuredBackup) ? configuredBackup : path.resolve(serverDirectory, configuredBackup))
  : path.join(backupDirectory, `appointments-${timestamp}.db`)

if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
  throw new Error('Backup destination must differ from the live database path.')
}

await mkdir(path.dirname(destinationPath), { recursive: true })
const database = new Database(sourcePath, { fileMustExist: true })
try {
  await database.backup(destinationPath)
  await chmod(destinationPath, 0o600).catch(() => {})
  console.log(`SQLite backup completed: ${destinationPath}`)
} finally {
  database.close()
}
