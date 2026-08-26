import type { RemoteTelegramStatus, RemoteTelegramUser } from '@shared/types'
import { createStore } from 'zustand'
import storage from '@/storage'

/**
 * Persistent session ↔ Telegram chat bindings.
 *
 * A binding is created whenever a chat is addressed through the bot (message
 * sent / chat created / completion button pressed). Completion notifications
 * for that chat are delivered back to the bound Telegram conversation.
 */
const BINDINGS_STORAGE_KEY = 'remote-control:session-bindings'

type SessionBindings = Record<string, string>

let bindingsCache: SessionBindings | null = null

async function readBindings(): Promise<SessionBindings> {
  if (bindingsCache) return bindingsCache
  try {
    const stored = await storage.getItem<SessionBindings | null>(BINDINGS_STORAGE_KEY, null)
    bindingsCache = stored && typeof stored === 'object' ? stored : {}
  } catch {
    bindingsCache = {}
  }
  return bindingsCache
}

async function writeBindings(bindings: SessionBindings): Promise<void> {
  bindingsCache = bindings
  await storage.setItem(BINDINGS_STORAGE_KEY, bindings)
}

export async function bindSession(sessionId: string, telegramChatId: string): Promise<void> {
  const bindings = await readBindings()
  if (bindings[sessionId] === telegramChatId) return
  await writeBindings({ ...bindings, [sessionId]: telegramChatId })
}

export async function getSessionBinding(sessionId: string): Promise<string | undefined> {
  const bindings = await readBindings()
  return bindings[sessionId]
}

export async function forgetSessionBinding(sessionId: string): Promise<void> {
  const bindings = await readBindings()
  if (!(sessionId in bindings)) return
  const next = { ...bindings }
  delete next[sessionId]
  await writeBindings(next)
}

/**
 * In-memory UI state shared with the Settings → Remote Access page:
 * polling status and pending authorization requests from unknown Telegram
 * accounts (they only get "No access" until a user approves them).
 */
export interface RemotePendingUser extends RemoteTelegramUser {
  username?: string
  requestedAt: number
}

interface RemoteUiState {
  status: RemoteTelegramStatus
  statusError?: string
  botUsername?: string
  pendingUsers: RemotePendingUser[]
}

const MAX_PENDING_USERS = 20

export const remoteUiStore = createStore<RemoteUiState>(() => ({
  status: 'stopped',
  pendingUsers: [],
}))

export function setRemoteStatus(status: RemoteTelegramStatus, error?: string) {
  remoteUiStore.setState({ status, statusError: error })
}

export function setBotUsername(username?: string) {
  remoteUiStore.setState({ botUsername: username })
}

/** Records an authorization request from an unknown account (dedup by id). */
export function notePendingUser(user: { id: string; name?: string; username?: string }) {
  const existing = remoteUiStore.getState().pendingUsers
  if (existing.some((candidate) => candidate.id === user.id)) return
  const pending: RemotePendingUser = {
    id: user.id,
    name: user.name,
    username: user.username,
    requestedAt: Date.now(),
  }
  remoteUiStore.setState({
    // Newest first; drop the oldest entries beyond the cap.
    pendingUsers: [pending, ...existing].slice(0, MAX_PENDING_USERS),
  })
}

export function dismissPendingUser(userId: string) {
  remoteUiStore.setState({
    pendingUsers: remoteUiStore.getState().pendingUsers.filter((user) => user.id !== userId),
  })
}
