'use strict';

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

function normalizeDegrees(value) {
  let result = value % 360;
  if (result < 0) result += 360;
  return result;
}

function normalizeHours(value) {
  let result = value % 24;
  if (result < 0) result += 24;
  return result;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function calculateUtcHour(date, latitude, longitude, sunrise) {
  const n = dayOfYear(date);
  const lngHour = longitude / 15;
  const t = sunrise
    ? n + ((6 - lngHour) / 24)
    : n + ((18 - lngHour) / 24);

  const m = (0.9856 * t) - 3.289;
  let l = m + (1.916 * Math.sin(degToRad(m))) + (0.020 * Math.sin(degToRad(2 * m))) + 282.634;
  l = normalizeDegrees(l);

  let ra = radToDeg(Math.atan(0.91764 * Math.tan(degToRad(l))));
  ra = normalizeDegrees(ra);

  const lQuadrant = Math.floor(l / 90) * 90;
  const raQuadrant = Math.floor(ra / 90) * 90;
  ra += (lQuadrant - raQuadrant);
  ra /= 15;

  const sinDec = 0.39782 * Math.sin(degToRad(l));
  const cosDec = Math.cos(Math.asin(sinDec));

  const zenith = 90.833;
  const cosH = (
    Math.cos(degToRad(zenith)) - (sinDec * Math.sin(degToRad(latitude)))
  ) / (cosDec * Math.cos(degToRad(latitude)));

  if (cosH > 1 || cosH < -1) return null;

  let h = sunrise
    ? 360 - radToDeg(Math.acos(cosH))
    : radToDeg(Math.acos(cosH));
  h /= 15;

  const localMeanTime = h + ra - (0.06571 * t) - 6.622;
  return normalizeHours(localMeanTime - lngHour);
}

function utcHourToDate(date, utcHour) {
  const hours = Math.floor(utcHour);
  const minutesFloat = (utcHour - hours) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, seconds));
}

function getSunTimes(date, latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const rise = calculateUtcHour(date, latitude, longitude, true);
  const set = calculateUtcHour(date, latitude, longitude, false);
  if (rise === null || set === null) return null;
  return {
    sunrise: utcHourToDate(date, rise),
    sunset: utcHourToDate(date, set),
  };
}

function isNight(date, latitude, longitude) {
  const times = getSunTimes(date, latitude, longitude);
  if (!times) return null;
  return date < times.sunrise || date >= times.sunset;
}

module.exports = { getSunTimes, isNight };
