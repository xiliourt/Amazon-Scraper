export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================
    // ROUTE 1: API REQUESTS (Only paths starting with /api)
    // ============================================================
    if (url.pathname.startsWith('/api')) {
      
      // 1. Handle CORS (Allow all origins for API)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
          },
        });
      }

      // --- Scraping Logic Starts Here ---
      const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
      ];

      const getHeaders = () => ({
        "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      });

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(targetUrl, {
          headers: getHeaders(),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
           return new Response(JSON.stringify({ error: `Target URL returned status ${response.status}` }), {
            status: response.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const html = await response.text();

        // Extraction Helpers
        const extractPrice = (text) => {
          const priceRegexes = [
            /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
            /<span[^>]*class=["'][^"']*aok-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
            /<span[^>]*class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\d.,]+)<\/span>/i,
            /id="priceblock_ourprice"[^>]*>([\d.,$€£]+)</i,
            /id="priceblock_dealprice"[^>]*>([\d.,$€£]+)</i
          ];
          for (const rx of priceRegexes) {
            const match = text.match(rx);
            if (match && match[1]) return match[1].trim();
          }
          return "N/A";
        };

        const parentPrice = extractPrice(html);
        let currentAsin = null;
        const asinMatch = html.match(/<input[^>]+id="ASIN"[^>]+value="(\w+)"/i) || html.match(/name="ASIN\.0"[^>]+value="(\w+)"/i);
        if (asinMatch) currentAsin = asinMatch[1];

        let variants = [];
        let message = "";
        let success = false;
        const baseUrl = new URL(targetUrl).origin;

        // Strategy 1: Classic
        const classicRegex = /dimensionValuesDisplayData"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;
        const asinMapRegex = /asinToDimensionIndexMap"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;
        const classicMatch = html.match(classicRegex);
        const mapMatch = html.match(asinMapRegex);

        if (classicMatch && mapMatch) {
          try {
            const cleanJson = (str) => str.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            const variationValues = JSON.parse(cleanJson(classicMatch[1]));
            const asinMap = JSON.parse(cleanJson(mapMatch[1]));
            const dimensions = Object.keys(variationValues);

            for (const [asin, indices] of Object.entries(asinMap)) {
              const variantDimensions = {};
              const nameParts = [];
              dimensions.forEach((dimKey, i) => {
                const val = variationValues[dimKey][indices[i]];
                variantDimensions[dimKey] = val;
                nameParts.push(val);
              });

              variants.push({
                name: nameParts.join(" / "),
                asin: asin,
                price: (asin === currentAsin && parentPrice !== "N/A") ? parentPrice : "Requires Page Visit",
                url: `${baseUrl}/dp/${asin}`,
                dimensions: variantDimensions
              });
            }
            success = true;
            message = `Found ${variants.length} variants (Classic Method).`;
          } catch (e) {
            console.log("Worker Classic Parse Error", e);
          }
        }

        // Strategy 2: Twister Plus
        if (!success) {
          const newTwisterRegex = /data-a-state="{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;}">\s*({[\s\S]*?})\s*<\/script>/;
          const newMatch = html.match(newTwisterRegex);

          if (newMatch) {
            try {
              const data = JSON.parse(newMatch[1]);
              if (data.sortedDimValuesForAllDims) {
                const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
                const selectedValues = {};
                dimKeys.forEach(key => {
                  const vals = data.sortedDimValuesForAllDims[key];
                  const sel = vals.find(v => v.dimensionValueState === 'SELECTED');
                  if (sel) selectedValues[key] = sel.dimensionValueDisplayText;
                });

                const seenAsins = new Set();
                dimKeys.forEach(targetDim => {
                  const values = data.sortedDimValuesForAllDims[targetDim];
                  values.forEach(v => {
                    if (v.defaultAsin && !seenAsins.has(v.defaultAsin)) {
                      const vDims = { ...selectedValues };
                      vDims[targetDim] = v.dimensionValueDisplayText;
                      const nameParts = dimKeys.map(k => vDims[k] || 'Unknown');
                      variants.push({
                        name: nameParts.join(" / "),
                        asin: v.defaultAsin,
                        price: (v.defaultAsin === currentAsin && parentPrice !== "N/A") ? parentPrice : "Requires Page Visit",
                        url: `${baseUrl}/dp/${v.defaultAsin}`,
                        dimensions: vDims
                      });
                      seenAsins.add(v.defaultAsin);
                    }
                  });
                });
                if (variants.length > 0) {
                  success = true;
                  message = `Found ${variants.length} variants (Twister Plus).`;
                }
              }
            } catch (e) {
              console.log("Worker NewTwister Parse Error", e);
            }
          }
        }

        // Bulk Scrape Logic
        if (success && variants.length > 0) {
          const fetchVariantPrice = async (variant) => {
            if (variant.price !== "Requires Page Visit") return;
            try {
              const subController = new AbortController();
              const subTimeout = setTimeout(() => subController.abort(), 6000);
              const res = await fetch(variant.url, {
                headers: getHeaders(),
                signal: subController.signal
              });
              clearTimeout(subTimeout);
              if (!res.ok) throw new Error("Fetch failed");
              const text = await res.text();
              const p = extractPrice(text);
              variant.price = p !== "N/A" ? p : "Unavailable";
            } catch (err) {
              variant.price = "Fetch Failed";
            }
          };

          const MAX_REQUESTS = 48;
          const variantsToFetch = variants
            .filter(v => v.price === "Requires Page Visit")
            .slice(0, MAX_REQUESTS);

          if (variantsToFetch.length > 0) {
            message += ` Bulk scraping ${variantsToFetch.length} items...`;
            await Promise.all(variantsToFetch.map(v => fetchVariantPrice(v)));
          }
        }

        return new Response(JSON.stringify({
          success,
          variants,
          parentPrice,
          message: message || (success ? "Extraction complete" : "No variants found or extraction failed"),
          debugInfo: "Processed by Cloudflare Worker (JSON Only)"
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ============================================================
    // ROUTE 2: STATIC ASSETS (Vite Output)
    // ============================================================
    // Any path NOT starting with /api falls through here.
    // This serves index.html, main.js, css, etc.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Fallback if ASSETS are not available (e.g. strict local dev mode)
    return new Response("Not Found", { status: 404 });
  },
};
