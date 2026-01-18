export interface VariantData {
  name: string;
  asin: string;
  price: string;
  url: string;
  dimensions: Record<string, string>;
}

export interface ScrapingResult {
  success: boolean;
  variants: VariantData[];
  parentPrice?: string;
  message?: string;
  debugInfo?: string;
}

export enum AppTab {
  EXTRACTOR = 'EXTRACTOR',
  GENERATOR = 'GENERATOR'
}