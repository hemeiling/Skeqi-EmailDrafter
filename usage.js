// Tracks API usage for the lifetime of the server process (matches the
// original EmailDrafter's in-memory _usage dict -- resets on restart, and
// has an explicit reset button in the UI).

const CLAUDE_INPUT_PRICE_PER_M = 3.00;   // USD per million input tokens
const CLAUDE_OUTPUT_PRICE_PER_M = 15.00; // USD per million output tokens

const usage = {
  claude_calls: 0,
  claude_input_tokens: 0,
  claude_output_tokens: 0,
  apollo_people_calls: 0,
  apollo_org_calls: 0
};

function recordClaudeUsage(apiUsage) {
  usage.claude_calls += 1;
  usage.claude_input_tokens += (apiUsage && apiUsage.input_tokens) || 0;
  usage.claude_output_tokens += (apiUsage && apiUsage.output_tokens) || 0;
}

function recordApolloPeopleCall() {
  usage.apollo_people_calls += 1;
}

function recordApolloOrgCall() {
  usage.apollo_org_calls += 1;
}

function claudeCost() {
  return (
    (usage.claude_input_tokens / 1_000_000) * CLAUDE_INPUT_PRICE_PER_M +
    (usage.claude_output_tokens / 1_000_000) * CLAUDE_OUTPUT_PRICE_PER_M
  );
}

function getUsage() {
  return {
    ...usage,
    claude_cost_usd: Math.round(claudeCost() * 1e6) / 1e6,
    claude_input_price_per_m: CLAUDE_INPUT_PRICE_PER_M,
    claude_output_price_per_m: CLAUDE_OUTPUT_PRICE_PER_M
  };
}

function resetUsage() {
  usage.claude_calls = 0;
  usage.claude_input_tokens = 0;
  usage.claude_output_tokens = 0;
  usage.apollo_people_calls = 0;
  usage.apollo_org_calls = 0;
}

module.exports = { recordClaudeUsage, recordApolloPeopleCall, recordApolloOrgCall, getUsage, resetUsage };
