
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");
    const mode = url.searchParams.get("mode") || "scrape"; // 'scrape' or 'proxy'

    // Handle CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
        },
      });
    }

    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
    ];
    const randomUa = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": randomUa,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });

      const html = await response.text();

      // If purely proxy mode is requested, return HTML
      if (mode === 'proxy') {
        return new Response(html, {
            headers: {
                "Content-Type": "text/html",
                "Access-Control-Allow-Origin": "*"
            }
        });
      }

      // --- Backend Scraping Logic ---

      // 1. Extract Price (Simple Regex)
      let price = "N/A";
      const priceRegexes = [
         /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
         /<span[^>]*class=["'][^"']*aok-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
         /<span[^>]*class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\d.,]+)<\/span>/i
      ];

      for (const rx of priceRegexes) {
          const match = html.match(rx);
          if (match && match[1]) {
              price = match[1].trim();
              break;
          }
      }

      // 2. Extract Variants
      let variants = [];
      let message = "";
      let success = false;
      const baseUrl = new URL(targetUrl).origin;

      // Strategy 1: Classic (dimensionValuesDisplayData)
      // Regex looks for: dimensionValuesDisplayData : { ... }
      const classicRegex = /dimensionValuesDisplayData"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;
      const asinMapRegex = /asinToDimensionIndexMap"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;

      const classicMatch = html.match(classicRegex);
      const mapMatch = html.match(asinMapRegex);

      if (classicMatch && mapMatch) {
          try {
             // Basic JSON cleanup for embedded JS objects
             const cleanJson = (str) => str.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
             const variationValues = JSON.parse(cleanJson(classicMatch[1]));
             const asinMap = JSON.parse(cleanJson(mapMatch[1]));
             
             const dimensions = Object.keys(variationValues);

             for (const [asin, indices] of Object.entries(asinMap)) {
                const variantDimensions = {};
                const nameParts = [];
                
                dimensions.forEach((dimKey, i) => {
                    const valIndex = indices[i];
                    const val = variationValues[dimKey][valIndex];
                    variantDimensions[dimKey] = val;
                    nameParts.push(val);
                });

                variants.push({
                    name: nameParts.join(" / "),
                    asin: asin,
                    price: "Requires Page Visit", // Worker doesn't deep fetch all 20+ pages to avoid timeouts
                    url: `${baseUrl}/dp/${asin}`,
                    dimensions: variantDimensions
                });
             }
             success = true;
             message = `Found ${variants.length} variants (Classic Method - Backend).`;
          } catch (e) {
              console.log("Worker Classic Parse Error", e);
          }
      }

      // Strategy 2: Newer (desktop-twister-sort-filter-data)
      if (!success) {
          // Look for <script type="a-state" ...> ... content ... </script>
          // We specifically want the one containing "desktop-twister-sort-filter-data"
          // This is harder with regex, but we can try to find the specific JSON blob
          const newTwisterRegex = /data-a-state="{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;}">\s*({[\s\S]*?})\s*<\/script>/;
          const newMatch = html.match(newTwisterRegex);

          if (newMatch) {
              try {
                  const data = JSON.parse(newMatch[1]);
                  if (data.sortedDimValuesForAllDims) {
                      const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
                      const selectedValues = {};
                      // Find selected
                      dimKeys.forEach(key => {
                          const vals = data.sortedDimValuesForAllDims[key];
                          const sel = vals.find(v => v.dimensionValueState === 'SELECTED');
                          if(sel) selectedValues[key] = sel.dimensionValueDisplayText;
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
                                      price: "Requires Page Visit",
                                      url: `${baseUrl}/dp/${v.defaultAsin}`,
                                      dimensions: vDims
                                  });
                                  seenAsins.add(v.defaultAsin);
                              }
                          });
                      });
                      
                      if(variants.length > 0) {
                          success = true;
                          message = `Found ${variants.length} variants (Twister Plus - Backend).`;
                      }
                  }
              } catch (e) {
                  console.log("Worker NewTwister Parse Error", e);
              }
          }
      }

      if (!success && variants.length === 0) {
          // If we couldn't parse variants on backend, return HTML to let frontend try its robust DOMParser
          return new Response(html, {
            headers: {
                "Content-Type": "text/html",
                "Access-Control-Allow-Origin": "*"
            }
          });
      }

      const result = {
          success,
          variants,
          parentPrice: price,
          message: message || "Extraction complete",
          debugInfo: "Processed by Cloudflare Worker"
      };

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
      });
    }
  },
};
