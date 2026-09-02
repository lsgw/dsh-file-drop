// dsh-file-drop · Client half（DSH web __ModuleLoader__ 格式）
// 两种模式职责互斥：upload 只复制文件/目录，locate 只获取或搜索原始路径。
// 回形针按钮选择文件；上传和定位模式都接管所有文件和目录，避免旁路各自的 Host 契约。
import { clientTestApi, initializeSettings, openModeChannel } from './runtime.js'
import { createView } from './view.js'

window.__ModuleLoader__.load({
  id: 'dsh-file-drop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { CSS, DropZone, PaperclipButton, SettingsSection } = createView(React)
    const inject = ['slots', 'workspaces', 'sessions']

    async function apply(ctx) {
      // 注册任何文件入口前先确认模式；失败时按定位模式接管并禁止上传。
      await initializeSettings()
      ctx.effect(openModeChannel, 'dsh-file-drop: settings channel')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-file-drop'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-file-drop: styles')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'file-drop-pick',
          order: 0,
          inject: () => ({ workspaces: ctx.workspaces, sessions: ctx.sessions }),
        },
        (props) => React.createElement(PaperclipButton, props)
      ))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'file-drop',
          order: 30,
          inject: () => ({ workspaces: ctx.workspaces, sessions: ctx.sessions }),
        },
        (props) => React.createElement(DropZone, props)
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-file-drop',
          order: 110,
          label: () => '拖拽文件',
          inject: () => ({ sessions: ctx.sessions }),
        },
        (props) => React.createElement(SettingsSection, props)
      ))
    }

    exports.__test = Object.freeze({
      ...clientTestApi,
      CSS,
      components: Object.freeze({ DropZone, PaperclipButton, SettingsSection }),
    })
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
