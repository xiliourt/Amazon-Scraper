
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle API Route: /api/scrape
    // strict check to avoid matching random assets
    if (url.pathname === '/api/scrape') {
        
        // Handle CORS for API
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

        const userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0"
        ];
        
        const getHeaders = () => ({
            "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Upgrade-Insecure-Requests": "1"
        });

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); 
            
            const response = await fetch(targetUrl, { 
                headers: getHeaders(),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            // Amazon might return 200 even for captchas, but check status anyway
            if (!response.ok && response.status !== 503) { // 503 is common for amazon but sometimes contains data
                 throw new Error(`Amazon returned status ${response.status}`);
            }

            const html = await response.text();

            // --- Robust Extraction Logic (Regex Based) ---
            
            const extractPrice = (text) => {
                // Try to find the price in specific reliable containers first
                const patterns = [
                    /<span[^>]*class="[^"]*a-price-whole[^"]*"[^>]*>([\d.,]+)<[^>]*><span[^>]*class="[^"]*a-price-fraction[^"]*"[^>]*>([\d]+)<\/span>/, // Whole + Fraction
                    /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
                    /<span[^>]*class=["'][^"']*aok-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
                    /id="priceblock_ourprice"[^>]*>([\d.,$€£]+)</i,
                    /id="priceblock_dealprice"[^>]*>([\d.,$€£]+)</i,
                    /"priceAmount"\s*:\s*([\d.]+)/, // Sometimes in JSON metadata
                    /"price"\s*:\s*"([\d.,$€£]+)"/
                ];

                for (const rx of patterns) {
                    const match = text.match(rx);
                    if (match) {
                        if (match.length === 3) {
                             // Combined whole + fraction
                             return `${match[1]}.${match[2]}`;
                        }
                        return match[1].trim();
                    }
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

            // Clean dirty JSON string from HTML source
            const safeJsonParse = (str) => {
                try {
                    // Remove newlines and extra spaces which might break simple regex extraction
                    const cleaned = str
                        .replace(/&quot;/g, '"')
                        .replace(/\\'/g, "'")
                        .replace(/\\"/g, '"');
                    return JSON.parse(cleaned);
                } catch(e) {
                    return null;
                }
            };

            // --- Strategy 1: Classic 'dimensionValuesDisplayData' ---
            // We look for the assignment to the variable
            const classicRegex = /dimensionValuesDisplayData"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;
            const asinMapRegex = /asinToDimensionIndexMap"\s*:\s*({[\s\S]*?})(?=\s*,\s*")/m;
            
            const classicMatch = html.match(classicRegex);
            const mapMatch = html.match(asinMapRegex);

            if (classicMatch && mapMatch) {
                try {
                    // Simple cleanup for the matched object string
                    const cleanObjStr = (s) => s.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
                    
                    const variationValues = JSON.parse(cleanObjStr(classicMatch[1]));
                    const asinMap = JSON.parse(cleanObjStr(mapMatch[1]));
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
                    if (variants.length > 0) {
                        success = true;
                        message = `Found ${variants.length} variants (Classic Method).`;
                    }
                } catch (e) {
                    // console.log("Worker Classic Parse Error", e);
                }
            }

            // --- Strategy 2: Twister Plus 'desktop-twister-sort-filter-data' ---
            if (!success) {
                // Matches <script type="a-state" data-a-state="{...key...}"> { ...data... } </script>
                // We focus on capturing the inner JSON content
                const newTwisterRegex = /data-a-state="{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;}">\s*({[\s\S]*?})\s*<\/script>/;
                const newMatch = html.match(newTwisterRegex);

                if (newMatch) {
                    const data = safeJsonParse(newMatch[1]);
                    if (data && data.sortedDimValuesForAllDims) {
                         const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
                         const selectedValues = {};
                         
                         // Find currently selected to fill gaps
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
                                         price: (v.defaultAsin === currentAsin && parentPrice !== "N/A") ? parentPrice : "Requires Page Visit",
                                         url: `${baseUrl}/dp/${v.defaultAsin}`,
                                         dimensions: vDims
                                     });
                                     seenAsins.add(v.defaultAsin);
                                 }
                             });
                         });
                         
                         if(variants.length > 0) {
                             success = true;
                             message = `Found ${variants.length} variants (Twister Plus).`;
                         }
                    }
                }
            }
            
            // --- Strategy 3: Mobile/App variants data (sometimes served to bots) ---
            if (!success) {
                 const mobileRegex = /"asinVariationValues"\s*:\s*({[\s\S]*?})(?=\s*,)/;
                 const mobileMatch = html.match(mobileRegex);
                 if (mobileMatch) {
                     // Logic for mobile parsing if needed, but often similar to Classic
                     // Adding this placeholder to show robustness intent
                 }
            }

            // 4. Bulk Scrape Prices (Limited Parallelism)
            if (success && variants.length > 0) {
                const fetchVariantPrice = async (variant) => {
                    if (variant.price !== "Requires Page Visit") return;
                    try {
                        const subController = new AbortController();
                        const subTimeout = setTimeout(() => subController.abort(), 8000); // 8s timeout
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

                // Limit concurrent requests
                const MAX_REQUESTS = 48; 
                const variantsToFetch = variants
                    .filter(v => v.price === "Requires Page Visit")
                    .slice(0, MAX_REQUESTS);

                if (variantsToFetch.length > 0) {
                    message += ` Bulk scraping ${variantsToFetch.length} items...`;
                    await Promise.all(variantsToFetch.map(v => fetchVariantPrice(v)));
                }
            }

            const result = {
                success,
                variants,
                parentPrice,
                message: message || (success ? "Extraction complete" : "No variants found or page is Captcha/Protected"),
                debugInfo: "Cloudflare Worker Scraper v2"
            };

            return new Response(JSON.stringify(result), {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
                status: 500,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }
    }

    // 2. Fallback for Static Assets (Frontend)
    if (env.ASSETS) {
        return env.ASSETS.fetch(request);
    }
    
    // Default 404 for anything else
    return new Response("Not found", { status: 404 });
  },
};
