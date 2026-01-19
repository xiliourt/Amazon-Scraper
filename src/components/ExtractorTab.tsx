
import React, { useState, useMemo, useRef } from 'react';
import { getPriceFromHtml } from '../utils/amazonScraper';
import { fetchViaProxy } from '../services/proxyService';
import { ScrapingResult, VariantData } from '../types';

type SortDirection = 'asc' | 'desc';
interface SortConfig {
  key: string;
  direction: SortDirection;
}

const BROWSER_SCRIPT = `(async function() {
    console.log("🚀 Starting Focused Product Extraction...");

    // ============================================================
    // 1. HELPERS & REGEX (Ported from Worker)
    // ============================================================
    
    const cleanText = (text) => text ? text.replace(/\\s+/g, ' ').trim() : null;

    // Robust Price Extractor
    const extractPrice = (text) => {
        const priceRegexes = [
            /<span[^>]*class=["'][^"']*aok-offscreen[^"']*["'][^>]*>[^<]*?([\\d.,$€£]+)[^<]*?<\\/span>/i,
            /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>\\s*([\\d.,$€£]+)\\s*<\\/span>/i,
            /<span[^>]*class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\\d.,]+)<\\/span>/i,
            /id="priceblock_ourprice"[^>]*>([\\d.,$€£]+)</i,
            /id="priceblock_dealprice"[^>]*>([\\d.,$€£]+)</i
        ];
        for (const rx of priceRegexes) {
            const match = text.match(rx);
            if (match && match[1]) {
                const val = match[1].trim();
                // Ensure it contains a digit
                if (/\\d/.test(val)) return val;
            }
        }
        return "N/A";
    };

    // Current Page State
    const html = document.documentElement.outerHTML;
    const baseUrl = window.location.origin;
    const currentAsin = document.querySelector('input[id="ASIN"]')?.value || 'Unknown';
    const parentPrice = extractPrice(html);

    let variants = [];
    let parsingStrategy = "None";

    // ============================================================
    // 2. VARIATION EXTRACTION STRATEGIES
    // ============================================================

    // --- STRATEGY A: CLASSIC (DimensionValuesDisplayData) ---
    const classicRegex = /dimensionValuesDisplayData"\\s*:\\s*({[\\s\\S]*?})(?=\\s*,\\s*")/m;
    const asinMapRegex = /asinToDimensionIndexMap"\\s*:\\s*({[\\s\\S]*?})(?=\\s*,\\s*")/m;
    const classicMatch = html.match(classicRegex);
    const mapMatch = html.match(asinMapRegex);

    if (classicMatch && mapMatch) {
        try {
            const cleanJson = (str) => str.replace(/,\\s*}/g, '}').replace(/,\\s*]/g, ']');
            const variationValues = JSON.parse(cleanJson(classicMatch[1]));
            const asinMap = JSON.parse(cleanJson(mapMatch[1]));
            const dimensions = Object.keys(variationValues);

            for (const [asin, indices] of Object.entries(asinMap)) {
                const nameParts = [];
                dimensions.forEach((dimKey, i) => {
                    nameParts.push(variationValues[dimKey][indices[i]]);
                });
                variants.push({
                    name: nameParts.join(" / "),
                    asin: asin,
                    price: (asin === currentAsin) ? parentPrice : "Requires Fetch",
                    url: \`\${baseUrl}/dp/\${asin}\`
                });
            }
            parsingStrategy = "Classic JSON";
        } catch (e) { console.error("Classic Parse Error", e); }
    }

    // --- STRATEGY B: TWISTER PLUS (Newer Amazon Layouts) ---
    if (variants.length === 0) {
        const newTwisterRegex = /data-a-state="{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;}">\\s*({[\\s\\S]*?})\\s*<\\/script>/;
        const newMatch = html.match(newTwisterRegex);
        if (newMatch) {
            try {
                const rawJson = newMatch[1].replace(/&quot;/g, '"'); 
                const data = JSON.parse(rawJson);
                
                if (data.sortedDimValuesForAllDims) {
                    const dimKeys = Object.keys(data.sortedDimValuesForAllDims);
                    const seenAsins = new Set();
                    
                    // Identify currently selected attributes to fill gaps
                    const selectedValues = {};
                    dimKeys.forEach(key => {
                        const vals = data.sortedDimValuesForAllDims[key];
                        const sel = vals.find(v => v.dimensionValueState === 'SELECTED');
                        if (sel) selectedValues[key] = sel.dimensionValueDisplayText;
                    });

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
                                    price: (v.defaultAsin === currentAsin) ? parentPrice : "Requires Fetch",
                                    url: \`\${baseUrl}/dp/\${v.defaultAsin}\`
                                });
                                seenAsins.add(v.defaultAsin);
                            }
                        });
                    });
                    parsingStrategy = "Twister Plus";
                }
            } catch (e) { console.error("Twister Parse Error", e); }
        }
    }

    // --- STRATEGY C: FALLBACK (Visual Scraping) ---
    if (variants.length === 0) {
        console.log("⚠️ No JSON data found. Trying visual fallback...");
        const variationRows = document.querySelectorAll('#twister .a-row');
        variationRows.forEach(row => {
            const labelNode = row.querySelector('.a-form-label');
            if (labelNode) {
                const label = cleanText(labelNode.innerText).replace(':', '');
                const swatches = row.querySelectorAll('li');
                swatches.forEach(swatch => {
                    const asin = swatch.getAttribute('data-dp-url')?.match(/\\/dp\\/(\\w+)/)?.[1] || swatch.getAttribute('data-defaultasin');
                    const img = swatch.querySelector('img');
                    const text = swatch.querySelector('.a-size-base');
                    const valName = img ? img.alt : (text ? text.innerText : "Unknown");
                    
                    if (asin) {
                        variants.push({
                            name: \`\${label}: \${valName}\`,
                            asin: asin,
                            price: "Requires Fetch",
                            url: \`\${baseUrl}/dp/\${asin}\`
                        });
                    }
                });
            }
        });
        parsingStrategy = "Visual Fallback";
    }

    // ============================================================
    // 3. BACKGROUND PRICE FETCHING
    // ============================================================
    
    // Config: How many items to fetch? (Set higher if you need total completeness)
    const MAX_FETCH = 20; 
    const variantsToFetch = variants.filter(v => v.price === "Requires Fetch").slice(0, MAX_FETCH);

    if (variantsToFetch.length > 0) {
        console.log(\`⏳ Background fetching prices for \${variantsToFetch.length} items...\`);
        
        await Promise.all(variantsToFetch.map(async (variant) => {
            try {
                const res = await fetch(variant.url);
                if(!res.ok) throw new Error("Network response not ok");
                const text = await res.text();
                const p = extractPrice(text);
                variant.price = (p !== "N/A") ? p : "Unavailable";
            } catch (err) {
                variant.price = "Fetch Failed";
            }
        }));
    }

    // ============================================================
    // 4. FINAL JSON ASSEMBLY
    // ============================================================
    const finalData = {
        meta: {
            url: window.location.href,
            timestamp: new Date().toISOString(),
            strategy: parsingStrategy,
            fetchedCount: variantsToFetch.length,
            totalVariationsFound: variants.length
        },
        product: {
            title: cleanText(document.querySelector('#productTitle')?.innerText),
            asin: currentAsin,
            currentPrice: parentPrice
        },
        variations: variants
    };

    console.clear();
    console.log("✅ Extraction Complete.");
    console.log(JSON.stringify(finalData, null, 2));
    
    return finalData;

})();`;

export const ExtractorTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'worker' | 'browser' | 'extension'>('worker');

  // Fetcher State
  const [fetchUrl, setFetchUrl] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Result State
  const [result, setResult] = useState<ScrapingResult | null>(null);
  
  // Sorting State
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  // Bulk Price Fetch State
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);
  const [priceProgress, setPriceProgress] = useState('');
  
  const resultIdRef = useRef<number>(0);

  const [copySuccess, setCopySuccess] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(BROWSER_SCRIPT).then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
    });
  };

  const handleFetch = async () => {
    if (!fetchUrl) return;
    setIsFetching(true);
    setFetchError('');
    setResult(null);
    setSortConfig(null); // Reset sort on new fetch
    setIsFetchingPrices(false);
    setPriceProgress('');
    resultIdRef.current += 1;

    try {
      const response = await fetchViaProxy(fetchUrl);
      
      if (typeof response === 'string') {
          console.warn("Received HTML from proxy service:", response.substring(0, 200));
          setFetchError("Worker configuration error: Received HTML instead of JSON. Ensure the worker is running at /api/scrape.");
      } else {
          setResult(response);
      }
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setIsFetching(false);
    }
  };

  // Only used if partial data is returned
  const fetchMissingPrices = async () => {
    if (!result || !result.variants) return;
    
    const currentRunId = resultIdRef.current;
    setIsFetchingPrices(true);
    
    const variantsToProcess = result.variants.map((v, i) => ({ ...v, originalIndex: i }));

    const updateVariantPrice = (index: number, price: string) => {
        setResult(prev => {
            if (!prev || !prev.variants) return prev;
            if (index < 0 || index >= prev.variants.length) return prev;
            const newVariants = [...prev.variants];
            if (newVariants[index]) {
                newVariants[index] = { ...newVariants[index], price };
            }
            return { ...prev, variants: newVariants };
        });
    };

    let processed = 0;
    const targets = variantsToProcess.filter(v => v.price === "Requires Page Visit");

    for (const v of targets) {
        if (currentRunId !== resultIdRef.current) break;

        setPriceProgress(`Fetching ${processed + 1} of ${targets.length}: ${v.name}`);
        try {
            if (processed > 0) await new Promise(r => setTimeout(r, 1000));
            if (currentRunId !== resultIdRef.current) break;

            const response = await fetchViaProxy(v.url);
            let price = "N/A";

            if (typeof response === 'string') {
                price = getPriceFromHtml(response);
            } else {
                price = response.parentPrice || "N/A";
            }
            
            if (currentRunId === resultIdRef.current) {
                updateVariantPrice(v.originalIndex, price);
            }
        } catch (err) {
            console.warn(`Failed to fetch price for ${v.asin}`, err);
            if (currentRunId === resultIdRef.current) {
                updateVariantPrice(v.originalIndex, "Fetch Failed");
            }
        }
        processed++;
    }
    
    if (currentRunId === resultIdRef.current) {
        setIsFetchingPrices(false);
        setPriceProgress('');
    }
  };

  const dimensionKeys = useMemo(() => {
    if (!result?.variants || result.variants.length === 0) return [];
    const firstVariant = result.variants[0];
    if (!firstVariant || !firstVariant.dimensions) return [];
    return Object.keys(firstVariant.dimensions);
  }, [result]);

  const hasMissingPrices = useMemo(() => {
      return result?.variants.some(v => v.price === "Requires Page Visit");
  }, [result]);

  // --- Sorting Logic ---
  const requestSort = (key: string) => {
    let direction: SortDirection = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedVariants = useMemo(() => {
    if (!result?.variants) return [];
    let items = [...result.variants];
    
    if (sortConfig) {
      items.sort((a, b) => {
        const { key, direction } = sortConfig;
        
        // Helper to extract numeric price for sorting
        const getPriceVal = (p: string) => {
             if (!p || p === "Requires Page Visit" || p === "N/A" || p === "Unavailable" || p === "Fetch Failed") return -1;
             // Remove currency symbols and commas (assuming standard format like $1,200.00)
             const clean = p.replace(/[^0-9.]/g, '');
             const num = parseFloat(clean);
             return isNaN(num) ? -1 : num;
        };

        if (key === 'price') {
             const valA = getPriceVal(a.price);
             const valB = getPriceVal(b.price);
             
             // Put invalid/unknown prices at the bottom always for ASC
             if (valA === -1 && valB === -1) return 0;
             if (valA === -1) return 1; 
             if (valB === -1) return -1;

             return direction === 'asc' ? valA - valB : valB - valA;
        } else {
             // String Sorting
             let valA = '';
             let valB = '';

             if (key === 'name') { valA = a.name; valB = b.name; }
             else if (key === 'asin') { valA = a.asin; valB = b.asin; }
             else {
                 // Dimensions
                 valA = a.dimensions?.[key] || '';
                 valB = b.dimensions?.[key] || '';
             }

             return direction === 'asc' 
                ? valA.localeCompare(valB) 
                : valB.localeCompare(valA);
        }
      });
    }
    return items;
  }, [result, sortConfig]);

  const SortIcon = ({ active, direction }: { active: boolean, direction: SortDirection }) => {
     if (!active) return <svg className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-50 transition-opacity ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" /></svg>;
     return direction === 'asc' 
        ? <svg className="w-3 h-3 text-emerald-400 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
        : <svg className="w-3 h-3 text-emerald-400 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>;
  };

  const TableHeader = ({ label, sortKey, className = "" }: { label: string, sortKey: string, className?: string }) => (
      <th 
        className={`px-6 py-4 cursor-pointer group select-none hover:bg-slate-800 transition-colors ${className}`}
        onClick={() => requestSort(sortKey)}
      >
        <div className="flex items-center">
            {label}
            <SortIcon active={sortConfig?.key === sortKey} direction={sortConfig?.direction || 'asc'} />
        </div>
      </th>
  );

  return (
    <div className="space-y-6">
      
      {/* TABS HEADER */}
      <div className="flex space-x-1 bg-slate-800 p-1 rounded-lg border border-slate-700 w-fit">
        <button 
           onClick={() => setActiveTab('worker')}
           className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${activeTab === 'worker' ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-white'}`}
        >
           Cloudflare Worker (Auto)
        </button>
        <button 
           onClick={() => setActiveTab('browser')}
           className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${activeTab === 'browser' ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-white'}`}
        >
           Browser Console (Manual)
        </button>
         <button 
           onClick={() => setActiveTab('extension')}
           className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${activeTab === 'extension' ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-white'}`}
        >
           Chrome Extension
        </button>
      </div>
      
      {activeTab === 'worker' ? (
        <>
            {/* SECTION 1: AUTO FETCH */}
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm animate-fade-in">
                <h2 className="text-xl font-semibold text-white mb-4">Fetch via Worker</h2>
                <p className="text-slate-400 text-sm mb-4">
                This uses the deployed Cloudflare Worker to scrape variant data and prices server-side.
                </p>
                
                <div className="flex gap-2">
                <input 
                    type="text"
                    value={fetchUrl}
                    onChange={(e) => setFetchUrl(e.target.value)}
                    placeholder="https://www.amazon.com/dp/B0..."
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                    onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
                />
                <button
                    onClick={handleFetch}
                    disabled={isFetching || !fetchUrl}
                    className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium px-6 py-3 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                    {isFetching ? (
                    <>
                        <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Fetching...
                    </>
                    ) : (
                    'Fetch & Extract'
                    )}
                </button>
                </div>
                
                {fetchError && (
                <div className="mt-3 p-3 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-xs font-mono break-all">
                    <strong>Error:</strong> {fetchError}
                </div>
                )}
            </div>

            {/* LOADING SCREEN */}
            {isFetching && (
                <div className="flex flex-col items-center justify-center p-12 bg-slate-800 rounded-xl border border-slate-700 shadow-sm min-h-[300px] animate-fade-in">
                <div className="relative mb-6">
                    <div className="absolute inset-0 bg-emerald-500/30 blur-xl rounded-full animate-pulse"></div>
                    <svg className="relative animate-spin h-16 w-16 text-emerald-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-3">Extracting Amazon Product Data</h3>
                <p className="text-slate-400 max-w-md text-center leading-relaxed">
                    Our worker is processing the page to extract variants and prices. 
                    <br/>
                    <span className="text-slate-500 text-sm mt-2 block">This typically takes 5-10 seconds to bypass protections.</span>
                </p>
                </div>
            )}

            {/* RESULTS */}
            {result && (
                <div className="animate-fade-in">
                <div className={`p-4 rounded-lg mb-6 border ${result.success ? 'bg-emerald-900/20 border-emerald-800' : 'bg-red-900/20 border-red-800'}`}>
                    <div className="flex items-start gap-3 justify-between">
                        <div className="flex gap-3">
                            {result.success ? (
                            <div className="text-emerald-500 mt-1">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                </svg>
                            </div>
                            ) : (
                            <div className="text-red-500 mt-1">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                </svg>
                            </div>
                            )}
                            <div>
                            <h3 className={`font-medium ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
                                {result.success ? 'Extraction Successful' : 'Extraction Failed'}
                            </h3>
                            <p className="text-slate-400 text-sm mt-1">{result.message}</p>
                            {result.debugInfo && <p className="text-slate-500 text-xs mt-1 font-mono">{result.debugInfo}</p>}
                            {result.parentPrice && <p className="text-slate-300 text-sm mt-2">Detected Base Price: <span className="font-mono text-white">{result.parentPrice}</span></p>}
                            </div>
                        </div>
                        {result.success && hasMissingPrices && (
                            <div className="flex flex-col items-end">
                                <button 
                                    onClick={fetchMissingPrices}
                                    disabled={isFetchingPrices}
                                    className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                                >
                                    {isFetchingPrices ? (
                                        <>
                                        <svg className="animate-spin h-3 w-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Stop
                                        </>
                                    ) : (
                                        "Fetch Missing Prices"
                                    )}
                                </button>
                                {priceProgress && <span className="text-xs text-indigo-300 mt-1">{priceProgress}</span>}
                            </div>
                        )}
                    </div>
                </div>

                {result.variants.length > 0 && (
                    <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm text-slate-400">
                        <thead className="bg-slate-900 text-xs uppercase text-slate-300 font-semibold">
                            <tr>
                            <TableHeader label="Variant Name" sortKey="name" />
                            {dimensionKeys.map(key => (
                                <TableHeader key={key} label={key.replace(/_/g, ' ')} sortKey={key} className="text-emerald-400" />
                            ))}
                            <TableHeader label="ASIN" sortKey="asin" />
                            <TableHeader label="Price" sortKey="price" />
                            <th className="px-6 py-4 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                            {sortedVariants.map((v: VariantData, idx) => (
                            <tr key={`${v.asin}-${idx}`} className="hover:bg-slate-700/50 transition-colors">
                                <td className="px-6 py-4 font-medium text-white">{v.name}</td>
                                {dimensionKeys.map(key => (
                                <td key={key} className="px-6 py-4 text-slate-300">
                                    {v.dimensions?.[key] || '-'}
                                </td>
                                ))}
                                <td className="px-6 py-4 font-mono text-indigo-300">{v.asin}</td>
                                <td className="px-6 py-4">
                                {v.price === "Requires Page Visit" ? (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-700 text-slate-300 border border-slate-600">
                                    Page Visit Req.
                                    </span>
                                ) : (
                                    <span className="text-white font-bold">{v.price}</span>
                                )}
                                </td>
                                <td className="px-6 py-4 text-right">
                                <a 
                                    href={v.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-emerald-400 hover:text-emerald-300 font-medium hover:underline"
                                >
                                    Open Product &rarr;
                                </a>
                                </td>
                            </tr>
                            ))}
                        </tbody>
                        </table>
                    </div>
                    </div>
                )}
                </div>
            )}
        </>
      ) : activeTab === 'browser' ? (
          <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-sm overflow-hidden animate-fade-in">
              <div className="p-6 border-b border-slate-700">
                  <h2 className="text-xl font-semibold text-white mb-2">Browser Console Script</h2>
                  <p className="text-slate-400 text-sm">
                      If the worker is blocked or you want to run this locally, paste the code below into your browser's developer console on any Amazon product page.
                  </p>
                  
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex items-start gap-3">
                          <div className="bg-indigo-500/10 text-indigo-400 font-bold w-6 h-6 rounded flex items-center justify-center shrink-0 text-xs">1</div>
                          <div className="text-xs text-slate-400">Open an Amazon product page in your browser.</div>
                      </div>
                      <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex items-start gap-3">
                          <div className="bg-indigo-500/10 text-indigo-400 font-bold w-6 h-6 rounded flex items-center justify-center shrink-0 text-xs">2</div>
                          <div className="text-xs text-slate-400">Right-click anywhere and select <strong>Inspect</strong>, then click the <strong>Console</strong> tab.</div>
                      </div>
                       <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex items-start gap-3">
                          <div className="bg-indigo-500/10 text-indigo-400 font-bold w-6 h-6 rounded flex items-center justify-center shrink-0 text-xs">3</div>
                          <div className="text-xs text-slate-400">Paste the code below and hit <strong>Enter</strong>. Results will print as JSON.</div>
                      </div>
                  </div>
              </div>
              
              <div className="relative bg-[#0d1117] p-4 overflow-x-auto">
                  <button 
                    onClick={handleCopy}
                    className="absolute top-4 right-4 z-10 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold py-1.5 px-3 rounded shadow transition-all flex items-center gap-2"
                  >
                      {copySuccess ? (
                          <>
                            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            Copied!
                          </>
                      ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                            Copy Code
                          </>
                      )}
                  </button>
                  <pre className="font-mono text-xs text-slate-300 leading-relaxed p-4">
                      <code>{BROWSER_SCRIPT}</code>
                  </pre>
              </div>
          </div>
      ) : (
        <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-sm animate-fade-in p-8">
            <div className="flex flex-col md:flex-row gap-8 items-start">
                <div className="flex-1 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="bg-indigo-500/10 p-2 rounded-lg">
                            <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                        </div>
                        <h2 className="text-2xl font-bold text-white">Browser Extension</h2>
                    </div>
                    
                    <p className="text-slate-300 leading-relaxed">
                        For users who extract data frequently, we offer a standalone Chrome Extension. 
                        This runs locally in your browser, bypassing many anti-bot checks associated with cloud scraping.
                    </p>

                    <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-4 space-y-3">
                         <h3 className="font-semibold text-emerald-400 text-sm uppercase tracking-wide">Installation Instructions</h3>
                         <ol className="list-decimal list-inside space-y-2 text-sm text-slate-300">
                             <li>Download the extension file below (<code className="bg-slate-800 px-1 rounded text-xs text-slate-400">.crx</code>).</li>
                             <li>Open Chrome and navigate to <code className="text-emerald-300 cursor-pointer hover:underline" onClick={() => navigator.clipboard.writeText('chrome://extensions')}>chrome://extensions</code>.</li>
                             <li>Enable <strong>Developer mode</strong> in the top right corner.</li>
                             <li>Drag and drop the downloaded file onto the page to install.</li>
                         </ol>
                    </div>

                    <a 
                      href="/AmazonBrowserExt.crx" 
                      download="AmazonBrowserExt.crx"
                      className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-6 rounded-lg transition-colors shadow-lg shadow-indigo-500/20"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        Download Extension (.crx)
                    </a>
                </div>

                 <div className="flex-1 bg-slate-900 border border-slate-700 rounded-lg p-6 flex flex-col justify-center items-center text-center space-y-4">
                    <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center">
                         <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <div>
                        <h4 className="font-medium text-white">Manual Sideloading</h4>
                        <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                            Since this extension is not in the Chrome Web Store, you must manually allow it. Chrome may warn you about extensions from unknown sources.
                        </p>
                    </div>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
