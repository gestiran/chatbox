import fs from 'node:fs'
import path from 'node:path'

import { app, session, type Session } from 'electron'
import log from 'electron-log/main'

/**
 * Пользовательский словарь проверки орфографии (Spell Check → «Add To Dictionary»).
 *
 * Проблема: на Linux вызов session.addWordToSpellCheckerDictionary() во время
 * работы приложения роняет браузерный процесс Electron — приложение мгновенно
 * закрывается без единой ошибки в логах (нативный краш в связке
 * Electron/Chromium/hunspell, воспроизводится когда spell checker уже подключён
 * к живым рендерерам). Само слово при этом успевает записаться в файл словаря
 * Chromium, поэтому после перезапуска оно перестаёт подчёркиваться.
 *
 * Обходное решение:
 * - Слово всегда сохраняется в собственный JSON-файл в userData.
 * - На Windows/macOS дополнительно вызываем нативный API — там он работает
 *   корректно, и слово перестаёт подчёркиваться сразу.
 * - Мгновенное применение слова на Linux выполняется через tryAddWordLive():
 *   spell checker временно выключается на время записи, поэтому активных
 *   слушателей у словаря нет — краш не возникает, слово действует сразу.
 *   Отключить мгновенное применение можно переменной окружения
 *   CHATBOX_SPELLCHECK_LIVE_ADD=0 (тогда слово применяется при следующем
 *   запуске через startup-синхронизацию).
 *
 * Если проблема будет исправлена в Electron, достаточно заменить
 * tryAddWordLive() на прямой нативный вызов и убрать ветку отложенной
 * синхронизации (offerRestartToApplyWord в main/menu.ts).
 */

const MAX_WORDS = 10_000
const MAX_WORD_LENGTH = 256

function getStorageFilePath(): string {
  return path.join(app.getPath('userData'), 'custom-spellcheck-words.json')
}

function sanitizeWord(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const word = raw.trim()
  // Пустые строки, слишком длинные строки и переносы строк недопустимы:
  // файл пользовательского словаря Chromium хранит слова построчно.
  if (!word || word.length > MAX_WORD_LENGTH || /[\r\n]/.test(word)) {
    return null
  }
  return word
}

/** Читает слова из собственного persistent-словаря приложения. */
export function loadStoredCustomWords(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getStorageFilePath(), 'utf8'))
    if (!Array.isArray(parsed)) {
      return []
    }
    const words = new Set<string>()
    for (const item of parsed) {
      const word = sanitizeWord(item)
      if (word) {
        words.add(word)
      }
      if (words.size >= MAX_WORDS) {
        break
      }
    }
    return [...words]
  } catch (error) {
    // Отсутствие файла при первом запуске — нормальная ситуация.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('spellchecker: failed to read custom words file', error)
    }
    return []
  }
}

function persistWords(words: readonly string[]): void {
  const filePath = getStorageFilePath()
  const tmpPath = `${filePath}.tmp`
  // Атомарная запись: сначала временный файл, затем rename,
  // чтобы словарь не оказался повреждён при сбое/выключении.
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmpPath, JSON.stringify([...new Set(words)], null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * Сохраняет слово в собственный persistent-словарь приложения.
 * Безопасно вызывать в любой момент работы main-процесса.
 */
export function rememberCustomWord(rawWord: string): string | null {
  const word = sanitizeWord(rawWord)
  if (!word) {
    return null
  }
  const stored = loadStoredCustomWords()
  if (!stored.some((existing) => existing.toLowerCase() === word.toLowerCase())) {
    stored.push(word)
    persistWords(stored)
  }
  return word
}

/**
 * Мгновенное («живое») добавление слова на Linux включено по умолчанию:
 * spell checker отключается на время записи и включается обратно, что
 * позволяет избежать краша Chromium и даёт эффект сразу (проверено на
 * Ubuntu). Принудительное отключение (слово будет применено при следующем
 * запуске): CHATBOX_SPELLCHECK_LIVE_ADD=0|false|no|off
 */
const FALSY_ENV_VALUES = new Set(['0', 'false', 'no', 'off'])

export function isLiveWordAddEnabled(): boolean {
  return !FALSY_ENV_VALUES.has((process.env.CHATBOX_SPELLCHECK_LIVE_ADD ?? '').trim().toLowerCase())
}

function restoreSpellcheckerState(ses: Session, wasEnabled: boolean, languages: readonly string[]): void {
  if (!wasEnabled) {
    return
  }
  try {
    if (languages.length > 0) {
      ses.setSpellCheckerLanguages([...languages])
    }
    ses.setSpellCheckerEnabled(true)
  } catch (error) {
    log.error('spellchecker: failed to restore spellchecker state after live add', error)
  }
}

/**
 * Пытается добавить слово в нативный словарь «на живую» без перезапуска:
 * временно выключает spell checker, добавляет слово и включает его обратно.
 * Возвращает true, только если слово точно применено. Любая ошибка
 * (включая отказ нативного API) приводит к восстановлению исходного
 * состояния и false — вызывающий код должен использовать запасной сценарий.
 */
export async function tryAddWordLive(rawWord: string, target?: Session): Promise<boolean> {
  const word = sanitizeWord(rawWord)
  const ses = target ?? session.defaultSession
  if (!word || !ses) {
    return false
  }
  let wasEnabled = false
  let prevLanguages: string[] = []
  try {
    wasEnabled = ses.isSpellCheckerEnabled()
    prevLanguages = [...ses.getSpellCheckerLanguages()]
    if (wasEnabled) {
      // Отключаем спеллчекер, чтобы на время добавления не осталось
      // активных spell checker'ов, получающих уведомления об изменении словаря.
      ses.setSpellCheckerEnabled(false)
    }
    const added = await ses.addWordToSpellCheckerDictionary(word)
    if (!added) {
      log.error(`spellchecker: native dictionary rejected word "${word}" during live add`)
      restoreSpellcheckerState(ses, wasEnabled, prevLanguages)
      return false
    }
    if (wasEnabled) {
      // Повторное включение пересоздаёт spell checker'ы с уже обновлённым
      // словарём — слово начинает действовать немедленно.
      restoreSpellcheckerState(ses, true, prevLanguages)
    }
    return true
  } catch (error) {
    log.error(`spellchecker: live add of "${word}" failed`, error)
    restoreSpellcheckerState(ses, wasEnabled, prevLanguages)
    return false
  }
}

/**
 * Синхронизирует сохранённые слова с нативным словарём Chromium.
 * Вызывается один раз при старте приложения ДО создания окон:
 * пока нет ни одного webContents, обновление словаря сводится к записи в файл
 * и не затрагивает проблемный путь с уведомлением активных spell checker'ов.
 */
export async function syncCustomWordsWithNativeDictionary(target?: Session): Promise<void> {
  try {
    const ses = target ?? session.defaultSession
    if (!ses) {
      return
    }
    const words = loadStoredCustomWords()
    if (words.length === 0) {
      return
    }
    const existing = new Set<string>()
    try {
      for (const word of await ses.listWordsInSpellCheckerDictionary()) {
        existing.add(word.toLowerCase())
      }
    } catch (error) {
      // Не критично: просто пере-добавим все сохранённые слова.
      log.warn('spellchecker: failed to list native dictionary words, will re-add all stored words', error)
    }
    let addedCount = 0
    for (const word of words) {
      if (existing.has(word.toLowerCase())) {
        continue
      }
      try {
        const added = await ses.addWordToSpellCheckerDictionary(word)
        if (added) {
          addedCount += 1
        } else {
          log.warn(`spellchecker: native dictionary rejected word "${word}"`)
        }
      } catch (error) {
        log.error(`spellchecker: failed to sync word "${word}" into native dictionary`, error)
      }
    }
    if (addedCount > 0) {
      log.info(`spellchecker: restored ${addedCount} custom word(s) into the native dictionary`)
    }
  } catch (error) {
    log.error('spellchecker: failed to sync custom words with the native dictionary', error)
  }
}
