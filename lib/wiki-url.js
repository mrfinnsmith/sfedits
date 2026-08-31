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

module.exports = {
  langFromEditUrl,
  getArticleUrl,
  getUserContributionsUrl
}
