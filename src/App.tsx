import React from 'react';
import { ExtractorTab } from './components/ExtractorTab';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 selection:bg-indigo-500/30">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="p-2 bg-gradient-to-tr from-indigo-500 to-purple-500 rounded-lg shadow-lg shadow-indigo-500/20">
               <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
               </svg>
             </div>
             <div>
               <h1 className="text-xl font-bold text-white tracking-tight">Amazon Scraper Tool</h1>
               <p className="text-xs text-slate-500 font-medium">Variant Extractor & Price Checker</p>
             </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
          <div className="animate-fade-in">
             <ExtractorTab />
          </div>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-8 text-center border-t border-slate-800/50 mt-8">
        <p className="text-slate-600 text-xs">
          Built with React 18, Tailwind, and Cloudflare Workers. 
          <br/>
          This tool is for educational purposes. Respect Amazon's Terms of Service.
        </p>
      </footer>
    </div>
  );
};

export default App;
