const maxmind = require('maxmind')
const path = require('path')

let reader = null

// Country code to flag emoji conversion
function countryToFlag(code) {
  if (!code || code.length !== 2) return ''
  return String.fromCodePoint(...[...code].map(c => c.charCodeAt(0) + 127397))
}

// Initialize the MaxMind database reader
async function initializeReader() {
  if (reader) return reader

  const dbPath = path.join(__dirname, '../data/GeoLite2-City.mmdb')

  try {
    reader = await maxmind.open(dbPath)
    return reader
  } catch (error) {
    console.warn(`Failed to initialize MaxMind reader: ${error.message}`)
    return null
  }
}

// Look up IP address and get country code
async function getCountryCode(ip) {
  const r = await initializeReader()
  if (!r) return null

  try {
    const response = r.get(ip)
    if (response && response.country && response.country.iso_code) {
      return response.country.iso_code
    }
  } catch (error) {
    // Invalid IP or lookup error, return null
  }

  return null
}

// Enrich text with country flag emoji after IP address
async function enrichIPWithCountry(ip, text) {
  if (!ip) return text

  const countryCode = await getCountryCode(ip)
  if (!countryCode) return text

  const flag = countryToFlag(countryCode)
  if (!flag) return text

  // Replace the IP address with IP + [flag]
  // Use word boundaries to avoid partial matches
  const regex = new RegExp(`\\b${ip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  return text.replace(regex, `${ip} [${flag}]`)
}

// Get country code for an IP without enriching text
async function enrichIPsInText(text) {
  // Find all IPs in text (IPv4 pattern)
  const ipv4Regex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  let enrichedText = text
  const matches = text.match(ipv4Regex)

  if (matches) {
    for (const ip of matches) {
      const countryCode = await getCountryCode(ip)
      if (countryCode) {
        const flag = countryToFlag(countryCode)
        if (flag) {
          // Replace this specific IP with IP [flag]
          const regex = new RegExp(`\\b${ip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
          enrichedText = enrichedText.replace(regex, `${ip} [${flag}]`)
        }
      }
    }
  }

  return enrichedText
}

module.exports = {
  initializeReader,
  getCountryCode,
  enrichIPWithCountry,
  enrichIPsInText,
  countryToFlag
}
