// OAuth 2.1 + PKCE authentication flow
// Uses native crypto.subtle for SHA-256 — no external dependencies

import type { OAuthTokenResponse } from './types.js';

/**
 * Generate a cryptographically random code verifier string (128 characters).
 * Uses the unreserved character set from RFC 7636.
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(96);
  crypto.getRandomValues(array);
  return base64UrlEncode(array).slice(0, 128);
}

/**
 * Generate a code challenge from the verifier using SHA-256 (S256 method).
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Build the authorization URL for the OAuth 2.1 + PKCE flow.
 */
export function buildAuthorizationUrl(
  instanceUrl: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  scope?: string
): string {
  const baseUrl = instanceUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  if (scope) {
    params.set('scope', scope);
  }

  return `${baseUrl}/oauth_auth.do?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens using the PKCE code verifier.
 */
export async function exchangeCodeForTokens(
  instanceUrl: string,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string
): Promise<OAuthTokenResponse> {
  const baseUrl = instanceUrl.replace(/\/$/, '');
  const tokenUrl = `${baseUrl}/oauth_token.do`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OAuth token exchange failed: ${response.status} ${response.statusText} — ${errorText}`
    );
  }

  return response.json() as Promise<OAuthTokenResponse>;
}

/** Base64url encode a Uint8Array (no padding). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
