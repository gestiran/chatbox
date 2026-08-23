import { app, type BrowserWindow, dialog, Menu, MenuItem, type MenuItemConstructorOptions, shell } from 'electron'
import log from 'electron-log'
import Locale from './locales'
import {
  canAddToNativeDictionaryAtRuntime,
  isLiveAddExperimentEnabled,
  rememberCustomWord,
  tryAddWordLive,
} from './spellcheck-dictionary'

interface DarwinMenuItemConstructorOptions extends MenuItemConstructorOptions {
  selector?: string
  submenu?: DarwinMenuItemConstructorOptions[] | Menu
}

export default class MenuBuilder {
  mainWindow: BrowserWindow

  private restartPromptVisible = false

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * На Linux нативный API добавления слова в рантайме роняет браузерный
   * процесс (см. spellcheck-dictionary.ts), поэтому слово применяется только
   * при старте приложения. Предлагаем пользователю перезапуститься сразу,
   * чтобы не дожидаться ручного перезапуска.
   */
  private async offerRestartToApplyWord(): Promise<void> {
    if (this.restartPromptVisible) {
      return
    }
    this.restartPromptVisible = true
    try {
      const win = this.mainWindow
      if (!win || win.isDestroyed()) {
        return
      }
      const locale = new Locale()
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: locale.t('AddToDictionary_RestartRequired'),
        buttons: [locale.t('Restart'), locale.t('Later')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (response === 0 && !win.isDestroyed()) {
        // Слова уже сохранены в persistent-словарь и будут применены
        // при старте нового экземпляра (см. main.ts → whenReady).
        app.relaunch()
        app.quit()
      }
    } catch (e) {
      log.error('spellchecker: failed to show restart prompt', e)
    } finally {
      this.restartPromptVisible = false
    }
  }

  /**
   * Экспериментальное мгновенное применение слова без перезапуска
   * (CHATBOX_SPELLCHECK_LIVE_ADD=1). При неудаче — обычный диалог перезапуска.
   */
  private async tryLiveAddThenFallback(word: string): Promise<void> {
    const win = this.mainWindow
    const session = win && !win.isDestroyed() ? win.webContents.session : undefined
    const applied = await tryAddWordLive(word, session)
    if (!applied) {
      await this.offerRestartToApplyWord()
    }
  }

  buildMenu(): Menu {
    const locale = new Locale()
    // 监听右键菜单
    this.mainWindow.webContents.on('context-menu', (event, props) => {
      const hasSelection = Boolean(props.selectionText?.trim())
      const misspelledWord = props.misspelledWord?.trim() ?? ''

      // 没有选中文本、也没有拼错的单词：禁止右键菜单
      if (!hasSelection && !misspelledWord) {
        event.preventDefault()
        return
      }
      const { x, y } = props
      const items: (Electron.MenuItem | Electron.MenuItemConstructorOptions)[] = [
        { role: 'copy', label: locale.t('Copy'), accelerator: 'CmdOrCtrl+C' },
        { role: 'cut', label: locale.t('Cut'), accelerator: 'CmdOrCtrl+X' },
        { role: 'paste', label: locale.t('Paste'), accelerator: 'CmdOrCtrl+V' },
        { role: 'pasteAndMatchStyle', label: locale.t('PasteAsPlainText'), accelerator: 'CmdOrCtrl+Shift+V' },
        // { type: 'separator' },
        // { role: 'resetZoom', label: locale.t('ResetZoom'), accelerator: 'CmdOrCtrl+0' },
        // { role: 'zoomIn', label: locale.t('ZoomIn'), accelerator: 'CmdOrCtrl+=' },
        // { role: 'zoomOut', label: locale.t('ZoomOut'), accelerator: 'CmdOrCtrl+-' },
      ]
      // Add each spelling suggestion
      for (const suggestion of props.dictionarySuggestions.slice(0, 3)) {
        items.push({
          label: `${locale.t('ReplaceWith')} "${suggestion}"`,
          click: () => this.mainWindow.webContents.replaceMisspelling(suggestion),
        })
      }
      if (misspelledWord) {
        items.push({ type: 'separator' })
        items.push({
          label: locale.t('AddToDictionary'),
          click: () => {
            // Любая ошибка здесь не должна убивать приложение:
            // process.on('uncaughtException') в main.ts завершает процесс при исключении.
            try {
              // 1. Всегда сохраняем слово в собственный persistent-словарь
              //    (восстанавливается при запуске, см. spellcheck-dictionary.ts).
              const word = rememberCustomWord(misspelledWord) ?? misspelledWord
              // 2. На Linux нативный API в рантайме вызывать нельзя — он роняет
              //    браузерный процесс (см. комментарий в spellcheck-dictionary.ts),
              //    поэтому там слово подействует после перезапуска.
              if (!canAddToNativeDictionaryAtRuntime()) {
                log.info(
                  `spellchecker: "${word}" saved, it will be applied to the native dictionary on next launch`,
                )
                if (isLiveAddExperimentEnabled()) {
                  void this.tryLiveAddThenFallback(word)
                } else {
                  void this.offerRestartToApplyWord()
                }
                return
              }
              // Electron API: session.addWordToSpellCheckerDictionary(word) возвращает Promise<boolean>.
              this.mainWindow.webContents.session
                .addWordToSpellCheckerDictionary(word)
                .then((added) => {
                  if (!added) {
                    log.error(`spellchecker: failed to add "${word}" to dictionary`)
                  }
                })
                .catch((e) => {
                  log.error(`spellchecker: error while adding "${word}" to dictionary`, e)
                })
            } catch (e) {
              log.error('spellchecker: failed to handle "Add To Dictionary" click', e)
            }
          },
        })
      }
      if (process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true') {
        items.push({
          label: 'Inspect element',
          click: () => {
            this.mainWindow.webContents.inspectElement(x, y)
          },
        })
      }
      Menu.buildFromTemplate(items).popup({ window: this.mainWindow })
    })

    const template = process.platform === 'darwin' ? this.buildDarwinTemplate() : this.buildDefaultTemplate()

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)

    return menu
  }

  buildDarwinTemplate(): MenuItemConstructorOptions[] {
    const subMenuAbout: DarwinMenuItemConstructorOptions = {
      label: 'Chatbox',
      submenu: [
        {
          label: 'About Chatbox',
          selector: 'orderFrontStandardAboutPanel:',
        },
        { type: 'separator' },
        { label: 'Services', submenu: [] },
        { type: 'separator' },
        {
          label: 'Hide Chatbox',
          accelerator: 'Command+H',
          selector: 'hide:',
        },
        {
          label: 'Hide Others',
          accelerator: 'Command+Shift+H',
          selector: 'hideOtherApplications:',
        },
        { label: 'Show All', selector: 'unhideAllApplications:' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'Command+Q',
          click: () => {
            app.quit()
          },
        },
      ],
    }
    const subMenuEdit: DarwinMenuItemConstructorOptions = {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Command+Z', selector: 'undo:' },
        {
          label: 'Redo',
          accelerator: 'Shift+Command+Z',
          selector: 'redo:',
        },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'Command+X', selector: 'cut:' },
        { label: 'Copy', accelerator: 'Command+C', selector: 'copy:' },
        {
          label: 'Paste',
          accelerator: 'Command+V',
          selector: 'paste:',
        },
        {
          label: 'Paste and Match Style',
          accelerator: 'Command+Shift+V',
          role: 'pasteAndMatchStyle',
        },
        {
          label: 'Select All',
          accelerator: 'Command+A',
          selector: 'selectAll:',
        },
      ],
    }
    const subMenuViewDev: MenuItemConstructorOptions = {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'Command+R',
          click: () => {
            this.mainWindow.webContents.reload()
          },
        },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Command+F',
          click: () => {
            this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
          },
        },
        // {
        //     label: 'Reset Zoom',
        //     accelerator: 'Command+0',
        //     role: 'resetZoom',
        // },
        // {
        //     label: 'Zoom In',
        //     accelerator: 'Command+=',
        //     role: 'zoomIn',
        // },
        // {
        //     label: 'Zoom Out',
        //     accelerator: 'Command+-',
        //     role: 'zoomOut',
        // },
        // {
        //   label: 'Toggle Developer Tools',
        //   accelerator: 'Alt+Command+I',
        //   click: () => {
        //     this.mainWindow.webContents.toggleDevTools();
        //   },
        // },
      ],
    }
    const subMenuViewProd: MenuItemConstructorOptions = {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Command+F',
          click: () => {
            this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Alt+Command+I',
          click: () => {
            this.mainWindow.webContents.toggleDevTools()
          },
        },
      ],
    }
    const subMenuWindow: DarwinMenuItemConstructorOptions = {
      label: 'Window',
      submenu: [
        {
          label: 'Minimize',
          accelerator: 'Command+M',
          selector: 'performMiniaturize:',
        },
        {
          label: 'Close',
          accelerator: 'Command+W',
          selector: 'performClose:',
        },
        { type: 'separator' },
        { label: 'Bring All to Front', selector: 'arrangeInFront:' },
      ],
    }
    const subMenuHelp: MenuItemConstructorOptions = {
      label: 'Help',
      submenu: [
        {
          label: 'Learn More',
          click() {
            shell.openExternal('https://chatboxai.app')
          },
        },
        {
          label: 'Github Repo',
          click() {
            shell.openExternal('https://github.com/chatboxai/chatbox')
          },
        },
        // {
        //   label: 'Community Discussions',
        //   click() {
        //     shell.openExternal('https://www.electronjs.org/community');
        //   },
        // },
        {
          label: 'Search Issues',
          click() {
            shell.openExternal('https://github.com/chatboxai/chatbox/issues?q=is%3Aissue')
          },
        },
      ],
    }

    const subMenuView =
      process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true' ? subMenuViewDev : subMenuViewProd

    return [subMenuAbout, subMenuEdit, subMenuView, subMenuWindow, subMenuHelp]
  }

  buildDefaultTemplate() {
    const templateDefault = [
      {
        label: '&File',
        submenu: [
          {
            label: '&Open',
            accelerator: 'Ctrl+O',
          },
          {
            label: '&Close',
            accelerator: 'Ctrl+W',
            click: () => {
              this.mainWindow.close()
            },
          },
        ],
      },
      {
        label: '&View',
        submenu:
          process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true'
            ? [
                {
                  label: '&Reload',
                  accelerator: 'Ctrl+R',
                  click: () => {
                    this.mainWindow.webContents.reload()
                  },
                },
                {
                  label: 'Toggle &Full Screen',
                  accelerator: 'F11',
                  click: () => {
                    this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
                  },
                },
                // {
                //   label: 'Toggle &Developer Tools',
                //   accelerator: 'Alt+Ctrl+I',
                //   click: () => {
                //     this.mainWindow.webContents.toggleDevTools();
                //   },
                // },
              ]
            : [
                {
                  label: 'Toggle &Full Screen',
                  accelerator: 'F11',
                  click: () => {
                    this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
                  },
                },
              ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Learn More',
            click() {
              shell.openExternal('https://chatboxai.app')
            },
          },
          {
            label: 'Github Repo',
            click() {
              shell.openExternal('https://github.com/chatboxai/chatbox')
            },
          },
          // {
          //   label: 'Community Discussions',
          //   click() {
          //     shell.openExternal('https://www.electronjs.org/community');
          //   },
          // },
          {
            label: 'Search Issues',
            click() {
              shell.openExternal('https://github.com/chatboxai/chatbox/issues?q=is%3Aissue')
            },
          },
        ],
      },
    ]

    return templateDefault
  }
}
