import { ScrapingResult } from '../types';

/**
 * List of CORS Proxies.
 * STRICT MODE: Only use the backend worker that returns JSON. 
 */
export const CORS_PROXIES = [
  // Cloudflare Worker Backend (Relative)
  '/api/scrape?url=',
  // External backup if local fails or isn't running
  // 'https://your-worker.workers.dev/api/scrape?url=' 
];

/**
 * Attempts to fetch the target URL using the defined proxies.
 * Stops at the first successful response.
 * Returns either a raw HTML string OR a pre-parsed ScrapingResult object.
 */
export const fetchViaProxy = async (targetUrl: string): Promise<string | ScrapingResult> => {
  const errors: string[] = [];

  if (!targetUrl.startsWith('http')) {
    throw new Error("URL must start with http:// or https://");
  }

  for (const proxyBase of CORS_PROXIES) {
    try {
      let fullUrl = proxyBase.startsWith('/') 
        ? `${proxyBase}${encodeURIComponent(targetUrl)}` 
        : `${proxyBase}${encodeURIComponent(targetUrl)}`; 
      
      console.log(`[ProxyService] Attempting fetch via: ${proxyBase}`);
      
      const response = await fetch(fullUrl);
      
      if (!response.ok) {
        // If 404/500, try next proxy
        throw new Error(`Status ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");
      
      // If content-type explicitly says json, parse it
      if (contentType && contentType.includes("application/json")) {
          const data = await response.json();
          if (data.error) throw new Error(data.error);
          return data as ScrapingResult;
      } 
      
      // If not strictly JSON, we need to verify it's not HTML error page
      const text = await response.text();
      
      // Heuristic: If it looks like HTML (starts with <), and we expected an API response, it's a failure of the proxy/routing
      if (text.trim().startsWith('<') || text.includes('<!DOCTYPE html>')) {
          throw new Error("Received HTML (likely index.html or 404 page) instead of JSON. Worker route not handled.");
      }

      // If it's some other string (unlikely), try to parse as JSON just in case
      try {
          const data = JSON.parse(text);
          if (data.error) throw new Error(data.error);
          return data as ScrapingResult;
      } catch (e) {
          throw new Error("Received invalid response format.");
      }

    } catch (err) {
      console.warn(`[ProxyService] Failed via ${proxyBase}:`, err);
      errors.push(`${proxyBase}: ${(err as Error).message}`);
    }
  }

  throw new Error(`All proxies failed. Ensure the Cloudflare Worker is running at /api/scrape.\nErrors:\n${errors.join('\n')}`);
};
