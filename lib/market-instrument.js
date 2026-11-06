function hasIdentity(profile, symbol) {
  return profile && !Array.isArray(profile) && typeof profile.name === 'string' && profile.name.trim()
    && typeof profile.ticker === 'string' && profile.ticker.toUpperCase() === symbol;
}

function instrumentFromReference(data, symbol) {
  const item = data?.results;
  if (data?.status !== 'OK' || !item || item.ticker !== symbol
    || typeof item.name !== 'string' || !item.name.trim()) {
    throw new Error('Unexpected instrument reference response');
  }
  const currency = typeof item.currency_name === 'string' ? item.currency_name.toUpperCase() : '';
  return {
    ticker: item.ticker, name: item.name, currency,
    exchange: item.primary_exchange || '', country: item.locale === 'us' ? 'US' : '',
    instrumentType: item.type || 'security', type: item.type || 'security',
    description: item.description || '', active: item.active,
    weburl: item.homepage_url || '', ipo: item.list_date || '',
    ...(Number.isFinite(item.market_cap) ? { marketCapitalization: item.market_cap / 1_000_000 } : {}),
    // Massive branding URLs require a server secret. Never send those URLs with a key.
    logo: '', source: 'Massive instrument reference',
  };
}

function createInstrumentResolver(readProfile, readReference) {
  return async function resolveInstrument(symbol) {
    let profile;
    let profileError;
    try { profile = await readProfile(symbol); } catch (error) { profileError = error; }
    if (hasIdentity(profile, symbol)) return { ...profile, instrumentType: profile.instrumentType || 'stock' };
    try {
      return instrumentFromReference(await readReference(symbol), symbol);
    } catch (error) {
      if (error.response?.status !== 404) throw error;
      // A failed profile request is not evidence that the instrument does not exist.
      if (profileError && profileError.response?.status !== 404) throw profileError;
      throw Object.assign(new Error('No matching security was found. Check the ticker and exchange.'), {
        status: 404, code: 'INSTRUMENT_NOT_FOUND',
      });
    }
  };
}

module.exports = { createInstrumentResolver, instrumentFromReference, hasIdentity };
