import { ScrapingResult } from '../types';

/**
 * List of CORS Proxies to try sequentially.
 * Users can add their own proxies here.
 * Ensure the proxy supports appending the target URL as a query parameter or path.
 */
export const CORS_PROXIES = [
  // Cloudflare Worker Backend (Relative path assumes same domain hosting or proxy rule)
  // If running locally with `npm start`, this might 404 unless a proxy is set up, 
  // so it gracefully fails over to the next ones.
  '/api/scrape?url=', 
  'https://cors.dylanacc009.workers.dev/?url=',
  // Add your custom proxies here
];

/**
 * Attempts to fetch the target URL using the defined proxies.
 * Stops at the first successful response.
 * Returns either a raw HTML string OR a pre-parsed ScrapingResult object.
 */
export const fetchViaProxy = async (targetUrl: string): Promise<string | ScrapingResult> => {
  const errors: string[] = [];

  // Basic validation
  if (!targetUrl.startsWith('http')) {
    throw new Error("URL must start with http:// or https://");
  }

  for (const proxyBase of CORS_PROXIES) {
    try {
      // Handle the local/worker endpoint specially if needed, but standard appending usually works
      // Construct URL. We use encodeURIComponent to ensure the target URL 
      // is treated as a single parameter by the proxy.
      let fullUrl = proxyBase.startsWith('/') 
        ? `${proxyBase}${encodeURIComponent(targetUrl)}` // Local/Worker
        : `${proxyBase}${encodeURIComponent(targetUrl)}`; // Remote Proxy
      
      console.log(`[ProxyService] Attempting fetch via: ${proxyBase}`);
      
      const response = await fetch(fullUrl);
      
      if (!response.ok) {
        // Continue to next proxy if 404/500 etc
        throw new Error(`Status ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");

      if (contentType && contentType.includes("application/json")) {
          // Backend did the work for us
          const data = await response.json();
          if (data.error) throw new Error(data.error);
          return data as ScrapingResult;
      } else {
          // Standard HTML response
          const text = await response.text();
          
          // Basic check to ensure we didn't just get an empty proxy error page
          if (!text || text.length < 500) { 
             throw new Error("Response too short or empty"); 
          }
          return text;
      }

    } catch (err) {
      console.warn(`[ProxyService] Failed via ${proxyBase}:`, err);
      errors.push(`${proxyBase}: ${(err as Error).message}`);
    }
  }

  throw new Error(`Failed to fetch via all proxies.\nErrors:\n${errors.join('\n')}`);
};
