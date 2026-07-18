// Per-building deployments set EXPO_PUBLIC_API_URL at build time (eas.json env or
// .env); default is the original 2020 building's API.
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://2020evapi-production.up.railway.app';

export const SOCKET_URL = API_URL;
