// What kind of editor a Wikipedia username names. Shared by the IRC parser
// (lib/wiki-changes.js), which sets edit.anonymous, and the edit log
// (lib/edit-log.js), which records the username, IP and anonymous flag, so the
// two can never disagree about who counts as anonymous.
//
// Wikipedia's data has no "anonymous" field. This rule is our judgment: the
// username is an IP address (logged-out edits before temporary accounts) or a
// temporary-account name.

// The IRC feed gives IPv6 addresses in full, uncompressed form.
function isIpAddress(user) {
  if (typeof user !== 'string') return false
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(user)
  const ipv6 = /^([0-9a-fA-F]*:){7}[0-9a-fA-F]*$/.test(user)
  return ipv4 || ipv6
}

// Since January 2026 Wikipedia shows logged-out editors as temporary accounts
// ("~2026-42504-55"). Some wikis, such as Czech Wikipedia, use a shorter form
// with only one dash group ("~2026-67040"). Wikimedia reserves the leading "~"
// for temporary accounts (issue #14).
function isTemporaryAccount(user) {
  return typeof user === 'string' && /^~\d{4}-\d+(-\d+)?$/.test(user)
}

function isAnonymous(user) {
  return isIpAddress(user) || isTemporaryAccount(user)
}

module.exports = {
  isIpAddress,
  isTemporaryAccount,
  isAnonymous
}
