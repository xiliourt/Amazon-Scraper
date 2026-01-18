# Amazon Price Scraper 
- Scrapes every color, size and variant of a single item for pricing.
- Uses Cloudflare workers to avoid cors and speed up scrapes - returns raw JSON.
- Feel free to monitor /api?url=(amazonURL) with changedetection.io or another tool.
  - In theory any change in price of any variant should trigger a notification.

## Deploy with Cloudflare
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiliourt/AWS-Scraper/)
