/**
 * Ask the app for an endpoint's model list (the settings model menus).
 *
 * The key travels in a POST body, never in the URL: next dev writes every
 * request URL to data/logs/choom-dev.log, and a GET with ?apiKey= put the
 * OpenRouter, Anthropic and NVIDIA keys there in plain text.
 */
export function requestModelList(endpoint: string, apiKey?: string): Promise<Response> {
  return fetch('/api/services/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(apiKey ? { endpoint, apiKey } : { endpoint }),
  });
}
