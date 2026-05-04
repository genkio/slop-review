import { store } from '../store.js'
import { escapeHtml, renderCrumb, homePath } from '../util.js'
import { openAddRepoModal, openRemoveRepoConfirmModal } from '../modals.js'

function renderRepoItem(r) {
  const home = store.state?.config?.home || ''
  const shown = homePath(r.path, home)
  return `
    <div class="list-item">
      <div class="grow">
        <div class="title">
          <a class="title-main" href="#/repo/${encodeURIComponent(r.id)}">${escapeHtml(r.display_name)}</a>
        </div>
        <div class="sub"><code>${escapeHtml(shown)}</code></div>
      </div>
      <div class="row-actions">
        <button class="danger" data-remove-repo="${r.id}">Remove</button>
      </div>
    </div>`
}

export function renderReposPage() {
  renderCrumb([{ label: 'Repos' }])
  const repos = store.state.repos || []
  const main = document.getElementById('main')
  main.innerHTML = `
    <div class="list">
      <div class="page-head">
        <h1>Repos</h1>
        <div class="actions">
          <button class="primary" id="add-repo">+ Add repo</button>
        </div>
      </div>
      ${
        repos.length === 0
          ? '<div class="empty">No repos yet. Click <b>+ Add repo</b> to bookmark a local git repo.</div>'
          : repos.map(renderRepoItem).join('')
      }
    </div>`

  document.getElementById('add-repo').onclick = () => openAddRepoModal(renderReposPage)
  main.querySelectorAll('[data-remove-repo]').forEach((b) => {
    b.onclick = () => openRemoveRepoConfirmModal(b.dataset.removeRepo, renderReposPage)
  })
}
