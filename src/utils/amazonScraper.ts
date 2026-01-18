import { VariantData, ScrapingResult } from '../types';

/**
 * Extracts the price from the parsed DOM.
 */
export const extractPrice = (doc: Document): string => {
  const selectors = [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen', // Common on some layouts
    '#corePriceDisplay_desktop_feature_div .aok-offscreen', // Specific to the provided AU example
    'span.a-price span.a-offscreen',
    'span.a-price span.aok-offscreen', // Variation of offscreen price
    '.aok-offscreen', // Fallback for AU style simple price
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    'span.a-price-whole',
    '.apexPriceToPay .a-offscreen',
    'div[id^="corePrice"] span.a-offscreen',
    'div[id^="corePrice"] span.aok-offscreen'
  ];

  for (const selector of selectors) {
    const elements = doc.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      const text = elements[i].textContent?.trim();
      // Ensure we got a valid price-like string (contains number) and isn't empty
      if (text && /\d/.test(text)) {
        return text;
      }
    }
  }
  return "N/A";
};

/**
 * Helper to get price from raw HTML string.
 */
export const getPriceFromHtml = (html: string): string => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return extractPrice(doc);
}

/**
 * Extracts the base domain from the HTML or falls back to a default/provided URL.
 */
const getBaseUrl = (doc: Document, providedUrl?: string): string => {
  // 1. Try canonical link
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical && canonical.getAttribute('href')) {
    try {
      const url = new URL(canonical.getAttribute('href')!);
      return url.origin;
    } catch (e) {
      // ignore invalid url
    }
  }

  // 2. Try provided URL
  if (providedUrl) {
    try {
      const url = new URL(providedUrl);
      return url.origin;
    } catch (e) {
      // ignore
    }
  }

  // 3. Fallback
  return "https://www.amazon.com";
};

/**
 * Parses the raw HTML string to find variant data.
 */
export const parseAmazonHtml = (htmlContent: string, sourceUrl?: string): ScrapingResult => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  
  const parentPrice = extractPrice(doc);
  const baseUrl = getBaseUrl(doc, sourceUrl);
  
  // Extract Current ASIN to map the parent price to the correct variant
  const currentAsinInput = doc.querySelector('input#ASIN');
  const currentAsin = currentAsinInput ? currentAsinInput.getAttribute('value') : null;

  let variants: VariantData[] = [];
  let message = '';

  // --- Strategy 1: Look for Twister data block (dimensionValuesDisplayData) ---
  const scripts = doc.querySelectorAll('script');
  let classicScriptContent: string | null = null;
  
  for (let i = 0; i < scripts.length; i++) {
    const content = scripts[i].textContent || "";
    if (content.includes('dimensionValuesDisplayData')) {
      classicScriptContent = content;
      break;
    }
  }

  if (classicScriptContent) {
    try {
      // Use [\s\S] instead of [^] for cross-browser compatibility
      const variationValuesMatch = classicScriptContent.match(/variationValues"\s*:\s*({[\s\S]*?})/);
      const asinMapMatch = classicScriptContent.match(/asinToDimensionIndexMap"\s*:\s*({[\s\S]*?})/);

      if (variationValuesMatch && asinMapMatch) {
        const cleanJson = (str: string) => str.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        const variationValues = JSON.parse(cleanJson(variationValuesMatch[1]));
        const asinMap = JSON.parse(cleanJson(asinMapMatch[1]));
        const dimensions = Object.keys(variationValues);

        for (const [asin, indices] of Object.entries(asinMap)) {
          const variantNameParts: string[] = [];
          const variantDimensions: Record<string, string> = {};
          const idxArray = indices as number[];

          dimensions.forEach((dimKey, i) => {
            try {
              const valueIndex = idxArray[i];
              const readableValue = variationValues[dimKey][valueIndex];
              variantNameParts.push(readableValue);
              variantDimensions[dimKey] = readableValue;
            } catch (e) {
              variantNameParts.push("Unknown");
            }
          });

          // Check if this variant is the current page
          const isCurrent = currentAsin && asin === currentAsin;

          variants.push({
            name: variantNameParts.join(" / "),
            asin: asin,
            price: isCurrent && parentPrice !== "N/A" ? parentPrice : "Requires Page Visit",
            url: `${baseUrl}/dp/${asin}`,
            dimensions: variantDimensions
          });
        }
        return { success: true, variants, parentPrice, message: `Found ${variants.length} variants (Classic Method).` };
      }
    } catch (e) {
      console.warn("Classic extraction failed", e);
    }
  }

  // --- Strategy 2: Look for 'desktop-twister-sort-filter-data' (Newer Amazon Layout) ---
  const stateScripts = doc.querySelectorAll('script[type="a-state"]');
  for (let i = 0; i < stateScripts.length; i++) {
    const script = stateScripts[i];
    const dataStateVal = script.getAttribute('data-a-state');
    if (dataStateVal && dataStateVal.includes('desktop-twister-sort-filter-data')) {
      try {
        const jsonContent = script.textContent;
        if (!jsonContent) continue;
        
        const data = JSON.parse(jsonContent);
        if (data.sortedDimValuesForAllDims) {
          const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
          
          // 1. Determine currently selected values to build context
          const selectedValues: Record<string, string> = {};
          dimKeys.forEach(key => {
            const values = data.sortedDimValuesForAllDims[key];
            const selected = values.find((v: any) => v.dimensionValueState === 'SELECTED');
            if (selected) {
              selectedValues[key] = selected.dimensionValueDisplayText;
            }
          });

          const seenAsins = new Set<string>();

          // 2. Iterate through dimensions to finding available variations (Cross-section)
          dimKeys.forEach(targetDim => {
            const values = data.sortedDimValuesForAllDims[targetDim];
            values.forEach((v: any) => {
              if (v.defaultAsin && !seenAsins.has(v.defaultAsin)) {
                
                // Construct a readable name
                const nameParts = dimKeys.map(dimKey => {
                  if (dimKey === targetDim) return v.dimensionValueDisplayText;
                  return selectedValues[dimKey] || 'Unknown';
                });

                const variantDimensions: Record<string, string> = { ...selectedValues };
                variantDimensions[targetDim] = v.dimensionValueDisplayText;
                
                // Check if this variant is the current page
                const isCurrent = currentAsin && v.defaultAsin === currentAsin;

                variants.push({
                  name: nameParts.join(" / "),
                  asin: v.defaultAsin,
                  price: isCurrent && parentPrice !== "N/A" ? parentPrice : "Requires Page Visit",
                  url: `${baseUrl}/dp/${v.defaultAsin}`,
                  dimensions: variantDimensions
                });
                seenAsins.add(v.defaultAsin);
              }
            });
          });

          if (variants.length > 0) {
            return { success: true, variants, parentPrice, message: `Found ${variants.length} variants (Twister Plus Method). Note: Some combinations may require page visits to reveal.` };
          }
        }
      } catch (e) {
        console.warn("Twister Plus extraction failed", e);
      }
    }
  }

  return {
    success: false,
    variants: [],
    parentPrice,
    message: "Could not find variant map (checked 'dimensionValuesDisplayData' and 'desktop-twister-sort-filter-data'). This might be a single item page.",
  };
};