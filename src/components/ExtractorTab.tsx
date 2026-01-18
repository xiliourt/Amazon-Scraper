import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { parseAmazonHtml, getPriceFromHtml } from '../utils/amazonScraper';
import { fetchViaProxy } from '../services/proxyService';
import { ScrapingResult, VariantData } from '../types';

export const ExtractorTab: React.FC = () => {
  // Manual Input State
  const [htmlInput, setHtmlInput] = useState('');
  
  // Fetcher State
  const [fetchUrl, setFetchUrl] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Result State
  const [result, setResult] = useState<ScrapingResult | null>(null);
  
  // Bulk Price Fetch State
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);
  const [priceProgress, setPriceProgress] = useState('');
  
  // Ref to track the current result ID to prevent race conditions from old fetch loops
  const resultIdRef = useRef<number>(0);

  const handleParse = useCallback(() => {
    if (!htmlInput.trim()) return;
    // Pass fetchUrl as context if available to help with domain resolution
    const data = parseAmazonHtml(htmlInput, fetchUrl);
    resultIdRef.current += 1; // Increment ID to invalidate old loops
    setResult(data);
    setIsFetchingPrices(false); // Stop any ongoing fetching
    setPriceProgress('');
  }, [htmlInput, fetchUrl]);

  const handleFetch = async () => {
    if (!fetchUrl) return;
    setIsFetching(true);
    setFetchError('');
    setResult(null);
    setHtmlInput(''); 
    setIsFetchingPrices(false);
    setPriceProgress('');
    resultIdRef.current += 1;

    try {
      const response = await fetchViaProxy(fetchUrl);
      
      if (typeof response === 'string') {
          // Received HTML (Client-side scraping)
          setHtmlInput(response); 
          const data = parseAmazonHtml(response, fetchUrl);
          setResult(data);
      } else {
          // Received Pre-parsed JSON (Server-side scraping)
          setResult(response);
          // If the backend failed to parse but returned a result object with failure, 
          // we can't easily populate htmlInput unless the API returned it.
          // For now, we trust the backend's message.
      }
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setIsFetching(false);
    }
  };

  const handleClear = () => {
    setHtmlInput('');
    setResult(null);
    setFetchError('');
    setIsFetchingPrices(false);
    setPriceProgress('');
    resultIdRef.current += 1;
  };

  const fetchMissingPrices = async () => {
    if (!result || !result.variants) return;
    
    const currentRunId = resultIdRef.current;
    setIsFetchingPrices(true);
    
    // Create a copy to iterate, but we will update state functionally
    const variantsToProcess = result.variants.map((v, i) => ({ ...v, originalIndex: i }));

    // Helper to safely update state
    const updateVariantPrice = (index: number, price: string) => {
        setResult(prev => {
            // Guard: If result was cleared or changed drastically (race condition), don't update
            if (!prev || !prev.variants) return prev;
            
            // Guard: Index out of bounds check
            if (index < 0 || index >= prev.variants.length) return prev;

            const newVariants = [...prev.variants];
            // Safe update ensuring we don't destroy existing properties like 'dimensions'
            if (newVariants[index]) {
                newVariants[index] = { ...newVariants[index], price };
            }
            return { ...prev, variants: newVariants };
        });
    };

    let processed = 0;
    const targets = variantsToProcess.filter(v => v.price === "Requires Page Visit");

    for (const v of targets) {
        // Stop if the user cleared results or parsed new HTML during fetch
        if (currentRunId !== resultIdRef.current) break;

        setPriceProgress(`Fetching ${processed + 1} of ${targets.length}: ${v.name}`);
        try {
            // Delay to be polite
            if (processed > 0) await new Promise(r => setTimeout(r, 1000));
            
            // Double check cancellation after delay
            if (currentRunId !== resultIdRef.current) break;

            const response = await fetchViaProxy(v.url);
            let price = "N/A";

            if (typeof response === 'string') {
                price = getPriceFromHtml(response);
            } else {
                // If the worker returns a scraping result object for a single page, 
                // we assume parentPrice is the price of that variant.
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

  // Determine dynamic columns based on the dimensions present in the first variant
  const dimensionKeys = useMemo(() => {
    if (!result?.variants || result.variants.length === 0) return [];
    const firstVariant = result.variants[0];
    // Safety check if dimensions is undefined
    if (!firstVariant || !firstVariant.dimensions) return [];
    return Object.keys(firstVariant.dimensions);
  }, [result]);

  const hasMissingPrices = useMemo(() => {
      return result?.variants.some(v => v.price === "Requires Page Visit");
  }, [result]);

  return (
    <div className="space-y-6">
      
      {/* SECTION 1: AUTO FETCH */}
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
        <h2 className="text-xl font-semibold text-white mb-4">Option 1: Fetch via Proxy/Backend</h2>
        <p className="text-slate-400 text-sm mb-4">
          Attempt to fetch the Amazon page directly. This will use the configured backend worker if available, falling back to client-side proxies.
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

      {/* SECTION 2: MANUAL PASTE */}
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
        <h2 className="text-xl font-semibold text-white mb-4">Option 2: Manual Source Paste</h2>
        <p className="text-slate-400 text-sm mb-4">
          If the fetcher is blocked: Go to the product page &rarr; Right Click &rarr; View Page Source &rarr; Copy All &rarr; Paste below.
        </p>
        
        <div className="relative">
          <textarea
            value={htmlInput}
            onChange={(e) => setHtmlInput(e.target.value)}
            placeholder="Paste HTML source code here..."
            className="w-full h-48 bg-slate-900 border border-slate-700 rounded-lg p-4 text-xs font-mono text-slate-300 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none resize-y"
          />
          {htmlInput && (
             <button 
               onClick={handleClear}
               className="absolute top-2 right-2 text-xs text-slate-500 hover:text-white bg-slate-800 px-2 py-1 rounded"
             >
               Clear
             </button>
          )}
        </div>

        <button
          onClick={handleParse}
          disabled={!htmlInput}
          className="mt-4 w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          Reprocess HTML
        </button>
      </div>

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
                      <th className="px-6 py-4">Variant Name</th>
                      
                      {/* Dynamic Dimension Headers */}
                      {dimensionKeys.map(key => (
                        <th key={key} className="px-6 py-4 text-emerald-400">{key.replace(/_/g, ' ')}</th>
                      ))}

                      <th className="px-6 py-4">ASIN</th>
                      <th className="px-6 py-4">Price</th>
                      <th className="px-6 py-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {result.variants.map((v: VariantData, idx) => (
                      <tr key={`${v.asin}-${idx}`} className="hover:bg-slate-700/50 transition-colors">
                        <td className="px-6 py-4 font-medium text-white">{v.name}</td>
                        
                        {/* Dynamic Dimension Values - Safe Access */}
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
    </div>
  );
};