
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle API Route: /api/scrape
    if (url.pathname === '/api/scrape') {
        
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

        const targetUrl = url.searchParams.get("url");

        if (!targetUrl) {
            return new Response(JSON.stringify({ error: "Missing url parameter" }), {
                status: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }

        const userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0"
        ];
        
        // Dynamic headers based on target URL
        const getHeaders = (target) => {
            let origin = "https://www.amazon.com";
            try { origin = new URL(target).origin; } catch(e){}
            
            return {
                "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Referer": origin + "/", // Mimic internal navigation
                "Cache-Control": "no-cache",
                "Upgrade-Insecure-Requests": "1"
            };
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); 
            
            const response = await fetch(targetUrl, { 
                headers: getHeaders(targetUrl),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok && response.status !== 503) {
                 throw new Error(`Amazon returned status ${response.status}`);
            }

            const html = await response.text();

            // --- Robust JSON Extractor (Brace Counting) ---
            // Regex is bad for nested JSON. This finds the start and counts braces.
            const extractJsonBlock = (source, startPattern) => {
                const match = source.match(startPattern);
                if (!match) return null;
                
                const startIndex = match.index + match[0].length;
                let openBraces = 0;
                let closeBraces = 0;
                let jsonString = "";
                let foundStart = false;

                // Scan forward from the regex match to find the first '{'
                for (let i = startIndex; i < source.length; i++) {
                    const char = source[i];
                    if (char === '{') {
                        if (!foundStart) foundStart = true;
                        openBraces++;
                    }
                    
                    if (foundStart) {
                        jsonString += char;
                        if (char === '}') {
                            closeBraces++;
                            // If balanced, we are done
                            if (openBraces === closeBraces) {
                                return jsonString;
                            }
                        }
                    } else if (!/\s/.test(char)) {
                        // If we hit non-whitespace before '{', the pattern match was wrong
                        return null;
                    }
                }
                return null;
            };

            const extractPrice = (text) => {
                const patterns = [
                    /<span[^>]*class="[^"]*a-price-whole[^"]*"[^>]*>([\d.,]+)<[^>]*><span[^>]*class="[^"]*a-price-fraction[^"]*"[^>]*>([\d]+)<\/span>/,
                    /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
                    /<span[^>]*class=["'][^"']*aok-offscreen[^"']*["'][^>]*>([\d.,$€£]+)<\/span>/i,
                    /id="priceblock_ourprice"[^>]*>([\d.,$€£]+)</i,
                    /id="priceblock_dealprice"[^>]*>([\d.,$€£]+)</i,
                    /"priceAmount"\s*:\s*([\d.]+)/,
                    /"price"\s*:\s*"([\d.,$€£]+)"/
                ];
                for (const rx of patterns) {
                    const match = text.match(rx);
                    if (match) {
                        if (match.length === 3) return `${match[1]}.${match[2]}`;
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
            // Use origin to support .com.au, .co.uk, etc.
            const baseUrl = new URL(targetUrl).origin;

            const safeJsonParse = (str) => {
                try {
                    // Basic cleanup for messy HTML-embedded JSON
                    return JSON.parse(str.replace(/&quot;/g, '"'));
                } catch(e) { return null; }
            };

            // --- Strategy 1: Classic 'dimensionValuesDisplayData' ---
            // Pattern: "dimensionValuesDisplayData" : { ... }
            const classicJsonStr = extractJsonBlock(html, /dimensionValuesDisplayData"\s*:\s*/);
            const mapJsonStr = extractJsonBlock(html, /asinToDimensionIndexMap"\s*:\s*/);

            if (classicJsonStr && mapJsonStr) {
                try {
                    const variationValues = safeJsonParse(classicJsonStr);
                    const asinMap = safeJsonParse(mapJsonStr);
                    
                    if (variationValues && asinMap) {
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
                    }
                } catch (e) { console.error("Strategy 1 failed", e); }
            }

            // --- Strategy 2: Twister Plus 'desktop-twister-sort-filter-data' ---
            // Pattern: data-a-state="{...key...}"> { ... } </script>
            // We search for the key, then extract the JSON block immediately following the tag closing >
            if (!success) {
                // Find the index of the specific key
                const keyIndex = html.indexOf('desktop-twister-sort-filter-data');
                if (keyIndex !== -1) {
                    // Find the next '>' after the key (closing the script tag attributes)
                    const tagClose = html.indexOf('>', keyIndex);
                    if (tagClose !== -1) {
                        // Extract JSON starting immediately after '>'
                        const twisterJsonStr = extractJsonBlock(html.substring(tagClose), /^/); // Start matching immediately
                        
                        if (twisterJsonStr) {
                            const data = safeJsonParse(twisterJsonStr);
                            if (data && data.sortedDimValuesForAllDims) {
                                const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
                                const selectedValues = {};
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
                }
            }

            // 4. Bulk Scrape Prices
            if (success && variants.length > 0) {
                const fetchVariantPrice = async (variant) => {
                    if (variant.price !== "Requires Page Visit") return;
                    try {
                        const subController = new AbortController();
                        const subTimeout = setTimeout(() => subController.abort(), 8000);
                        const res = await fetch(variant.url, { 
                            headers: getHeaders(variant.url),
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

            const result = {
                success,
                variants,
                parentPrice,
                message: message || (success ? "Extraction complete" : "No variants found. The page might be protected or use a layout not yet supported."),
                debugInfo: `Processed by Worker v3. Origin: ${baseUrl}`
            };

            return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
                status: 500,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
