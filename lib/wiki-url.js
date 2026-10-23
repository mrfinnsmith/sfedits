// Language code and URL builders for a Wikipedia edit. The language code is
// not in the IRC feed: edit.wikipedia is a display name ("English Wikipedia"),
// so the code has to come off the diff URL's hostname. page-watch.js derived
// it inline in two places before this module existed; edit-log.js needed it a
// third time, which is where copy-paste stops being acceptable.

// "https://en.wikipedia.org/w/index.php?diff=..." -> "en". Null if malformed.
function langFromEditUrl(editUrl) {
  try {
    return new URL(editUrl).hostname.split('.')[0]
  } catch {
    return null
  }
}

// Builds Wikipedia article URL from edit URL. Returns null if URL is malformed.
function getArticleUrl(editUrl, pageName) {
  const lang = langFromEditUrl(editUrl)
  if (!lang) return null
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pageName)}`
}

// Builds Wikipedia contributions URL from edit URL. Null if URL is malformed.
function getUserContributionsUrl(editUrl, username) {
  const lang = langFromEditUrl(editUrl)
  if (!lang) return null
  return `https://${lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(username)}`
}

// Revision id of the edit a diff URL shows. IRC diff URLs carry it as `diff=<revid>`
// (with `oldid=<parentid>`); `diff=prev` and bare `oldid=<revid>` URLs (page creation)
// show the revision in `oldid`. Null when no revision id can be read, including
// `diff=next`, which names the revision after the one in `oldid`.
function revisionIdFromDiffUrl(editUrl) {
  let params
  try {
    params = new URL(editUrl).searchParams
  } catch {
    return null
  }
  const diff = params.get('diff')
  if (diff !== null && /^\d+$/.test(diff)) return parseInt(diff, 10)
  if (diff !== null && diff !== 'prev') return null
  const oldid = params.get('oldid')
  return oldid !== null && /^\d+$/.test(oldid) ? parseInt(oldid, 10) : null
}

// Diff URL in the form the bot's IRC feed uses. With no parent revision (page
// creation) it links the revision alone.
function buildDiffUrl(lang, revid, parentid) {
  if (!parentid) return `https://${lang}.wikipedia.org/w/index.php?oldid=${revid}`
  return `https://${lang}.wikipedia.org/w/index.php?diff=${revid}&oldid=${parentid}`
}

module.exports = {
  langFromEditUrl,
  getArticleUrl,
  getUserContributionsUrl,
  revisionIdFromDiffUrl,
  buildDiffUrl
}
