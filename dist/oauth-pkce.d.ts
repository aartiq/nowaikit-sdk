import type { OAuthTokenResponse } from './types.js';
/**
 * Generate a cryptographically random code verifier string (128 characters).
 * Uses the unreserved character set from RFC 7636.
 */
export declare function generateCodeVerifier(): string;
/**
 * Generate a code challenge from the verifier using SHA-256 (S256 method).
 */
export declare function generateCodeChallenge(verifier: string): Promise<string>;
/**
 * Build the authorization URL for the OAuth 2.1 + PKCE flow.
 */
export declare function buildAuthorizationUrl(instanceUrl: string, clientId: string, redirectUri: string, codeChallenge: string, scope?: string): string;
/**
 * Exchange an authorization code for tokens using the PKCE code verifier.
 */
export declare function exchangeCodeForTokens(instanceUrl: string, clientId: string, redirectUri: string, code: string, codeVerifier: string): Promise<OAuthTokenResponse>;
//# sourceMappingURL=oauth-pkce.d.ts.map