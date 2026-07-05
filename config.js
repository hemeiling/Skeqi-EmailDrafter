// Centralized configuration. This is the ONLY place environment variables
// are read from in the whole app -- every other module imports values from
// here instead of touching process.env directly. If a new API key or
// service is added later, it gets a line here, not scattered across files.
//
// All values come from the environment (a local .env file, loaded via
// dotenv below, or real env vars set on the host/deploy platform). Nothing
// here is ever sent to the browser -- see server.js, which only exposes
// boolean "is this configured" flags, never the values themselves.

require('dotenv').config();

const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PORT = process.env.PORT || 3000;

function isApolloConfigured() {
  return Boolean(APOLLO_API_KEY);
}
function isClaudeConfigured() {
  return Boolean(CLAUDE_API_KEY);
}
function isLoginGateConfigured() {
  return Boolean(APP_USERNAME && APP_PASSWORD);
}

module.exports = {
  APOLLO_API_KEY,
  CLAUDE_API_KEY,
  APP_USERNAME,
  APP_PASSWORD,
  PORT,
  isApolloConfigured,
  isClaudeConfigured,
  isLoginGateConfigured
};
