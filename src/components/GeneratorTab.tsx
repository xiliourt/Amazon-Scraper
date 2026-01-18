import React, { useState } from 'react';
import { generateNodeScript } from '../services/geminiService';

export const GeneratorTab: React.FC = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [error, setError] = useState('');

  const handleGenerate = async () => {
    if (!url) return;
    setLoading(true);
    setError('');
    setGeneratedCode('');
    
    try {
      const code = await generateNodeScript(url);
      setGeneratedCode(code);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedCode);
    alert('Code copied to clipboard!');
  };

  return (
    <div className="space-y-6">
       <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
        <h2 className="text-xl font-semibold text-white mb-4">Generate Automation Script</h2>
        <p className="text-slate-400 text-sm mb-4">
          To run a scraper automatically, you need a Node.js environment. Enter an Amazon URL below, and Gemini will generate a custom Puppeteer script optimized for that product type.
        </p>
        
        <div className="flex gap-2">
          <input 
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.amazon.com/dp/B0..."
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !url}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium px-6 py-3 rounded-lg transition-colors flex items-center gap-2"
          >
            {loading ? (
              <>
                 <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Generating...
              </>
            ) : (
              <>
                <span>Generate</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-sm">
          Error: {error}
        </div>
      )}

      {generatedCode && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden shadow-lg animate-fade-in">
          <div className="bg-slate-950 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
             <div className="flex gap-2">
               <div className="w-3 h-3 rounded-full bg-red-500"></div>
               <div className="w-3 h-3 rounded-full bg-amber-500"></div>
               <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
             </div>
             <div className="text-xs font-mono text-slate-500">scraper.js</div>
             <button onClick={copyToClipboard} className="text-xs text-indigo-400 hover:text-indigo-300 font-medium">
               Copy Code
             </button>
          </div>
          <pre className="p-6 overflow-x-auto text-sm font-mono text-slate-300 leading-relaxed">
            <code>{generatedCode}</code>
          </pre>
        </div>
      )}
    </div>
  );
};