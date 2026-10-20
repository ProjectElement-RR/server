// API version-specific date headers from Rec-Room-Patches
// Ensures proper HTTP date formatting for 2017 client compatibility

// Default profile image last modified date for 24 March 2017 build
const DEFAULT_PROFILE_IMAGE_LAST_MODIFIED = 'Fri, 24 Mar 2017 00:50:23 GMT';

// Map API versions to their corresponding dates
const API_VERSION_DATES = {
  '2017-01-11': 'Wed, 11 Jan 2017 00:00:00 GMT',
  '2017-01-20': 'Fri, 20 Jan 2017 00:00:00 GMT',
  '2017-01-26': 'Thu, 26 Jan 2017 00:00:00 GMT',
  '2017-02-01': 'Wed, 01 Feb 2017 00:00:00 GMT',
  '2017-02-03': 'Fri, 03 Feb 2017 00:00:00 GMT',
  '2017-02-10': 'Fri, 10 Feb 2017 00:00:00 GMT',
  '2017-02-11': 'Sat, 11 Feb 2017 00:00:00 GMT',
  '2017-02-14': 'Tue, 14 Feb 2017 00:00:00 GMT',
  '2017-02-22': 'Wed, 22 Feb 2017 00:00:00 GMT',
  '2017-02-23': 'Thu, 23 Feb 2017 00:00:00 GMT',
  '2017-02-24': 'Fri, 24 Feb 2017 00:00:00 GMT',
  '2017-03-01': 'Wed, 01 Mar 2017 00:00:00 GMT',
  '2017-03-03': 'Fri, 03 Mar 2017 00:00:00 GMT',
  '2017-03-09': 'Thu, 09 Mar 2017 00:00:00 GMT',
  '2017-03-10': 'Fri, 10 Mar 2017 00:00:00 GMT',
  '2017-03-13': 'Mon, 13 Mar 2017 00:00:00 GMT',
  '2017-03-17': 'Fri, 17 Mar 2017 00:00:00 GMT',
  '2017-03-23': 'Thu, 23 Mar 2017 00:00:00 GMT',
  '2017-03-24': 'Fri, 24 Mar 2017 00:00:00 GMT',
  '2017-03-25': 'Sat, 25 Mar 2017 00:00:00 GMT',
  '2017-03-28': 'Tue, 28 Mar 2017 00:00:00 GMT',
  '2017-03-29': 'Wed, 29 Mar 2017 00:00:00 GMT',
  '2017-03-31': 'Fri, 31 Mar 2017 00:00:00 GMT'
};

// Get the default last modified date for profile images
function getDefaultProfileImageLastModified() {
  return DEFAULT_PROFILE_IMAGE_LAST_MODIFIED;
}

// Get the API version date for a specific version string
function getApiVersionDate(version) {
  // Default to 24 March 2017 if no specific version provided
  return API_VERSION_DATES[version] || DEFAULT_PROFILE_IMAGE_LAST_MODIFIED;
}

// Add proper HTTP date headers to response
function addApiHeaders(res, version = '2017-03-24') {
  res.setHeader('Last-Modified', getApiVersionDate(version));
  res.setHeader('Date', new Date().toUTCString());
  res.setHeader('Cache-Control', 'public, max-age=3600');
}

// Compare two HTTP dates for equality, ignoring sub-second precision.
//
// HTTP-date has one-second resolution, so two dates that represent the same
// instant can differ in milliseconds depending on how they were produced (a
// file mtime is a float, a header round-trip through new Date().toUTCString()
// truncates). Without this tolerance a resource that genuinely has not changed
// can be reported as modified, defeating caching.
//
// Returns false if either value is not a parseable date, so a malformed header
// falls through to a normal 200 rather than a spurious 304.
function sameHttpDate(a, b) {
  const left = a instanceof Date ? a : new Date(a);
  const right = b instanceof Date ? b : new Date(b);

  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;

  // Truncate both to whole seconds, which is HTTP-date's actual resolution.
  return Math.floor(left.getTime() / 1000) === Math.floor(right.getTime() / 1000);
}

// Check if client should get 304 Not Modified based on If-Modified-Since header
//
// Semantics: a 304 is correct when the resource has not been modified *since*
// the date the client holds, i.e. lastModified <= ifModifiedSince.
function checkNotModified(req, res, lastModified) {
  const ifModifiedSince = req.get('If-Modified-Since');

  if (!ifModifiedSince) return false;

  const clientDate = new Date(ifModifiedSince);
  const serverDate = new Date(lastModified);

  // Unparseable header: send the resource.
  if (Number.isNaN(clientDate.getTime()) || Number.isNaN(serverDate.getTime())) return false;

  // Ignore sub-second differences on the client date, per RFC 9110.
  const clientSeconds = Math.floor(clientDate.getTime() / 1000) * 1000;

  if (serverDate.getTime() <= clientSeconds) {
    res.status(304).end();
    return true;
  }

  return false;
}

module.exports = {
  getDefaultProfileImageLastModified,
  getApiVersionDate,
  addApiHeaders,
  checkNotModified,
  sameHttpDate,
  DEFAULT_PROFILE_IMAGE_LAST_MODIFIED
};
