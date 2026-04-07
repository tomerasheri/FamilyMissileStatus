'use strict';

/**
 * Reverse geocoding via OpenStreetMap Nominatim.
 * Returns { cityHe, cityEn } for a lat/lon pair.
 *
 * We request results in Hebrew first (to match the Hebrew city names used by
 * the Home Front Command alerts API), then fall back to English.
 */

const axios = require('axios');

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

// Nominatim requires a descriptive User-Agent
const UA = 'FamilyMissileStatusBot/1.0 (safety-bot)';

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {{ cityHe: string|null, cityEn: string|null, display: string }}
 */
async function reverseGeocode(lat, lon) {
  const params = {
    lat,
    lon,
    format:          'json',
    addressdetails:  1,
    zoom:            10,   // city-level granularity
  };

  // Fetch Hebrew and English names in parallel
  const [heRes, enRes] = await Promise.all([
    axios.get(NOMINATIM, {
      params: { ...params, 'accept-language': 'he' },
      headers: { 'User-Agent': UA },
      timeout: 8000,
    }).catch(() => null),
    axios.get(NOMINATIM, {
      params: { ...params, 'accept-language': 'en' },
      headers: { 'User-Agent': UA },
      timeout: 8000,
    }).catch(() => null),
  ]);

  const cityHe = extractCity(heRes?.data?.address) || null;
  const cityEn = extractCity(enRes?.data?.address) || null;
  const display = heRes?.data?.display_name || enRes?.data?.display_name || `${lat},${lon}`;

  return { cityHe, cityEn, display };
}

function extractCity(address) {
  if (!address) return null;
  // Nominatim may use different keys depending on the place type
  return (
    address.city       ||
    address.town       ||
    address.village    ||
    address.suburb     ||
    address.county     ||
    null
  );
}

/**
 * Normalise a city name from the alerts API for comparison:
 * "תל אביב - מרכז העיר" → "תל אביב"
 * Strips the qualifier after " - " or " – ".
 */
function normalizeAlertCity(name) {
  return name.split(/\s[-–]\s/)[0].trim();
}

/**
 * Check whether a user's stored city_he matches an alerted city name.
 * Uses normalisation and substring matching to handle partial matches.
 */
function cityMatches(userCityHe, alertCityName) {
  if (!userCityHe || !alertCityName) return false;
  const u = normalizeAlertCity(userCityHe);
  const a = normalizeAlertCity(alertCityName);
  return a.includes(u) || u.includes(a);
}

module.exports = { reverseGeocode, normalizeAlertCity, cityMatches };
