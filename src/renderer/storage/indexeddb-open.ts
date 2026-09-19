/**
 * Utilities for opening IndexedDB databases with recovery from a corrupted
 * Chromium backing store.
 *
 * Chromium may fail `indexedDB.open()` with `UnknownError: Internal error.`
 * when the underlying LevelDB files on disk are corrupted (e.g. after an
 * unclean shutdown or a disk failure). This error is permanent until the
 * database is removed: every open attempt fails again, on every app start.
 *
 * To recover, we detect such errors, delete the corrupted database and retry
 * the open once with a fresh backing store. Data of that database is lost in
 * this case, but the app becomes usable again instead of failing forever.
 */

/**
 * Detects the Chromium "backing store corrupted" failure surfaced as
 * `DOMException { name: 'UnknownError', message: 'Internal error.' }`.
 */
export function isBackingStoreCorruptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { name, message } = error as { name?: unknown; message?: unknown }
  return name === 'UnknownError' || (typeof message === 'string' && /internal error/i.test(message))
}

export function deleteDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    // "blocked" means another open connection still exists; the deletion will
    // complete once it closes, and the follow-up open attempt will wait for it.
    request.onblocked = () => resolve()
  })
}

/**
 * Opens an IndexedDB database, recreating it from scratch if the existing
 * backing store is corrupted.
 *
 * @param dbName database name
 * @param onUpgradeNeeded called on `upgradeneeded` to create stores/indexes
 * @param version optional explicit schema version (omit to open whatever exists)
 */
export async function openDatabaseWithRecovery(
  dbName: string,
  onUpgradeNeeded: (db: IDBDatabase, request: IDBOpenDBRequest) => void,
  version?: number
): Promise<IDBDatabase> {
  const attemptOpen = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = version !== undefined ? indexedDB.open(dbName, version) : indexedDB.open(dbName)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
      request.onupgradeneeded = () => onUpgradeNeeded(request.result, request)
    })

  try {
    return await attemptOpen()
  } catch (error) {
    if (!isBackingStoreCorruptionError(error)) {
      throw error
    }
    console.warn(
      `[indexeddb] database "${dbName}" appears corrupted (${(error as DOMException)?.name}: ${
        (error as DOMException)?.message
      }); deleting and recreating it`
    )
    try {
      await deleteDatabase(dbName)
    } catch (deleteError) {
      console.error(`[indexeddb] failed to delete corrupted database "${dbName}":`, deleteError)
    }
    return attemptOpen()
  }
}
