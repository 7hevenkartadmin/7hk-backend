export function integrationFixturesRequired(source = process.env) {
  return source.REQUIRE_INTEGRATION_FIXTURES === 'true';
}

export function unavailableIntegrationFixture(t, fixtureName, error, source = process.env) {
  const message = `${fixtureName} fixture unavailable: ${error?.message || 'unknown error'}`;
  if (integrationFixturesRequired(source)) {
    throw new Error(message, { cause: error });
  }
  t.skip(message);
  return false;
}
