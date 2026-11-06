/** Reject provider failures before they can be cached as an empty chart. */
function validateAggregates(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object'
    || (data.status !== undefined && !['OK', 'DELAYED'].includes(data.status))) {
    throw new Error('Unexpected aggregate response status');
  }

  const rows = data.results;
  const counts = [data.resultsCount, data.count].filter(count => count !== undefined);
  // The provider omits results for a legitimate interval without trades.
  if (rows === undefined && counts.length && counts.every(count => count === 0)) return;
  if (!Array.isArray(rows)
    || counts.some(count => count !== rows.length)
    || rows.some(bar => !bar || typeof bar !== 'object'
      || !Number.isFinite(bar.t) || bar.t < 0 || bar.t > 8_640_000_000_000_000
      || !Number.isFinite(bar.c) || bar.c <= 0)) {
    throw new Error('Unexpected aggregate response rows');
  }
  for (const bar of rows) {
    for (const field of ['o', 'h', 'l', 'vw']) {
      if (bar[field] !== undefined && (!Number.isFinite(bar[field]) || bar[field] <= 0)) {
        throw new Error('Unexpected aggregate price field');
      }
    }
    for (const field of ['v', 'n']) {
      if (bar[field] !== undefined && (!Number.isFinite(bar[field]) || bar[field] < 0)) {
        throw new Error('Unexpected aggregate volume field');
      }
    }
  }
}

module.exports = { validateAggregates };
