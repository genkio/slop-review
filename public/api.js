export async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status)
  return data
}
