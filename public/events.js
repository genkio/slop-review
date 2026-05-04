import { route } from './router.js'
import { toast, copyToClipboard } from './util.js'
import { openThreadModal } from './modals.js'

export function attachEvents() {
  document.addEventListener('click', async (e) => {
    const showThread = e.target.closest('[data-show-thread]')
    if (showThread) {
      const threadId = showThread.dataset.showThread
      openThreadModal(threadId)
      return
    }

    const copy = e.target.closest('[data-copy]')
    if (copy) {
      try {
        await copyToClipboard(copy.dataset.copy)
        toast('Copied')
      } catch (err) {
        toast('Copy failed: ' + (err.message || 'unknown'))
      }
      return
    }
  })

  window.addEventListener('hashchange', route)
}
