import { ScrapingResult } from '../types';

/**
 * List of CORS Proxies.
 * STRICT MODE: Only use the backend worker that returns JSON. 
 * Do not fall back to generic proxies that return HTML.
 */
export const CORS_PROXIES = [
  // Cloudflare Worker Backend
  '/api/scrape?url=', 
  // If you have a deployed worker, add it here:
  // 'https://your-worker-name.your-subdomain.workers.dev/api/scrape?url='
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
      // Handle the local/worker endpoint specially if needed, but standard appending usually works
      let fullUrl = proxyBase.startsWith('/') 
        ? `${proxyBase}${encodeURIComponent(targetUrl)}` 
        : `${proxyBase}${encodeURIComponent(targetUrl)}`; 
      
      console.log(`[ProxyService] Attempting fetch via: ${proxyBase}`);
      
      const response = await fetch(fullUrl);
      
      if (!response.ok) {
        throw new Error(`Status ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");

      if (contentType && contentType.includes("application/json")) {
          const data = await response.json();
          if (data.error) throw new Error(data.error);
          return data as ScrapingResult;
      } else {
          // If we get HTML here, it means the worker route is likely 404ing (hitting React index.html) 
          // or the proxy is misconfigured.
          const text = await response.text();
          return text;
      }

    } catch (err) {
      console.warn(`[ProxyService] Failed via ${proxyBase}:`, err);
      errors.push(`${proxyBase}: ${(err as Error).message}`);
    }
  }

  throw new Error(`Failed to fetch via worker.\nErrors:\n${errors.join('\n')}`);
};
