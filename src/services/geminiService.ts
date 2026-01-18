import { GoogleGenAI } from "@google/genai";

export const generateNodeScript = async (targetUrl: string): Promise<string> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
    You are an expert in Web Scraping and Node.js.
    
    The user wants to scrape Amazon product variants from this URL: ${targetUrl}
    
    The user originally provided a Python script using 'requests' and 'BeautifulSoup', but browsers cannot make cross-origin requests to Amazon.
    
    Please generate a robust **Node.js script** (using 'puppeteer-core' or 'puppeteer' and 'cheerio') that performs the equivalent logic:
    1. Launches a browser (headless: "new").
    2. Navigates to the URL with a realistic User-Agent.
    3. Extracts variant data. You MUST check for TWO possible data sources in the HTML:
       a. The classic 'dimensionValuesDisplayData' object inside standard <script> tags.
       b. The newer 'desktop-twister-sort-filter-data' inside <script type="a-state"> tags.
    4. Parses the JSON to map ASINs to variant names (Colors/Sizes).
    5. Prints the results as JSON.
    
    Do not use 'requests' logic. Use Puppeteer to handle dynamic content rendering if necessary, but try to extract from the initial HTML if possible for speed.
    Provide strictly the code block.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-latest',
      contents: prompt,
    });
    
    // Clean up markdown blocks if present
    let code = response.text || '// Error generating code';
    code = code.replace(/```javascript/g, '').replace(/```js/g, '').replace(/```/g, '');
    return code.trim();
  } catch (error) {
    console.error("Gemini Error:", error);
    return `// Error generating script: ${(error as Error).message}`;
  }
};