import { route } from './router.js'
import { attachEvents } from './events.js'
import { mountInstallBanner } from './banner.js'

attachEvents()
mountInstallBanner()
route()
