// Per-session dismissal: the banner reappears in a fresh browser tab/session
// but stays hidden across hash-route navigations and SPA re-renders within
// the same session. Shown unconditionally — slop-review is a single-user app
// where the AI-assisted workflow is the headline feature, so the install
// suggestion is broadly relevant. Users who already installed the skill
// dismiss once and never see it again that session.
const DISMISS_KEY = 'slop-review:install-banner:closed'

export function mountInstallBanner() {
  const host = document.getElementById('install-banner')
  if (!host) return

  try {
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return
  } catch {
    // sessionStorage can throw in privacy-mode embeds; treat as "not dismissed".
  }

  host.innerHTML = `
    <div class="install-banner-body">
      <span class="install-banner-text">
        Install the slop-review skill to enable AI-assisted reviewing:
        <code>npx skills add genkio/slop-review</code>
      </span>
      <button type="button" class="install-banner-close" aria-label="Dismiss">×</button>
    </div>
  `
  host.hidden = false

  host.querySelector('.install-banner-close')?.addEventListener('click', () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}
    host.hidden = true
    host.innerHTML = ''
  })
}
