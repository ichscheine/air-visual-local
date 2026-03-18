const NIGHTLY_RATE_PATTERNS = [
  /\$([\d,]+(?:\.\d{2})?)\s*per\s*night/i,
  /\$([\d,]+)\s*\/\s*night/i,
  /\$([\d,]+)\s*night/i,
  /nightly rate[^$]*\$([\d,]+(?:\.\d{2})?)/i
];

const TOTAL_RATE_PATTERNS = [
  /\$([\d,]+(?:\.\d{2})?)\s*total\s+before\s+taxes/i,
  /\$([\d,]+(?:\.\d{2})?)\s*total/i,
  /\$([\d,]+(?:\.\d{2})?)\s*for\s*(\d+)\s*nights?/i
];

const OCCUPANCY_PATTERNS = [
  /occupancy[^0-9]{0,20}(\d{1,3})%/i,
  /(\d{1,3})%\s*occupancy/i
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "AIR_VISUAL_EXTRACT_LISTING") {
    return false;
  }

  try {
    sendResponse(extractListingContext());
  } catch (error) {
    sendResponse({
      ok: false,
      error: error?.message || "Listing extraction failed."
    });
  }
  return true;
});

function extractListingContext() {
  const title = getListingTitle();
  const nightlyRate = detectNightlyRate();
  const occupancyEstimate = detectOccupancyEstimate();
  const photos = collectPhotos();
  const visibleText = document.body?.innerText?.slice(0, 12000) ?? "";

  return {
    ok: true,
    pageType: detectPageType(),
    listingUrl: window.location.href,
    title,
    nightlyRate,
    occupancyEstimate,
    photos,
    amenitiesPreview: extractAmenitiesPreview(visibleText),
    extractedAt: new Date().toISOString()
  };
}

function detectPageType() {
  const path = window.location.pathname;
  if (path.includes("/rooms/")) {
    return "guest_listing";
  }
  if (path.includes("/hosting/")) {
    return "host_dashboard";
  }
  return "unknown";
}

function getListingTitle() {
  const heading = document.querySelector("h1");
  if (heading?.textContent?.trim()) {
    return heading.textContent.trim();
  }

  const title = document.title.replace(/\s*\|\s*Airbnb.*$/i, "").trim();
  return title || "Airbnb listing";
}

function detectNightlyRate() {
  const structuredRate = detectStructuredNightlyRate();
  if (structuredRate) {
    return structuredRate;
  }

  const textSources = collectPriceTexts();
  for (const text of textSources) {
    const directRate = matchNightlyRate(text);
    if (directRate) {
      return directRate;
    }
  }

  const derivedRate = deriveNightlyRateFromTotal(textSources);
  if (derivedRate) {
    return derivedRate;
  }

  return { value: null, source: "unavailable" };
}

function detectOccupancyEstimate() {
  const text = document.body?.innerText ?? "";
  for (const pattern of OCCUPANCY_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]) / 100;
      if (value > 0 && value <= 1) {
        return {
          value,
          source: "page"
        };
      }
    }
  }

  return {
    value: null,
    source: "unavailable"
  };
}

function collectPhotos() {
  const images = Array.from(document.images);
  const candidates = images
    .map((image, index) => normalisePhoto(image, index))
    .filter(Boolean)
    .slice(0, 12);

  return dedupePhotos(candidates);
}

function normalisePhoto(image, index) {
  const url = getImageUrl(image);
  if (!url) {
    return null;
  }

  if (!url.startsWith("https://")) {
    return null;
  }

  const rect = image.getBoundingClientRect();
  const score = Math.max(rect.width, image.naturalWidth) * Math.max(rect.height, image.naturalHeight);

  if (score < 40000) {
    return null;
  }

  if (!isLikelyListingPhoto(url, image.alt)) {
    return null;
  }

  return {
    id: `photo-${index + 1}`,
    index,
    url,
    alt: image.alt?.trim() || "",
    width: image.naturalWidth || Math.round(rect.width),
    height: image.naturalHeight || Math.round(rect.height),
    score
  };
}

function getImageUrl(image) {
  const srcset = image.getAttribute("srcset");
  if (srcset) {
    const lastItem = srcset
      .split(",")
      .map((item) => item.trim().split(" ")[0])
      .filter(Boolean)
      .at(-1);
    if (lastItem) {
      return lastItem;
    }
  }

  return image.currentSrc || image.src || "";
}

function isLikelyListingPhoto(url, alt) {
  const urlLooksRight = /airbnb|muscache|cdn/i.test(url);
  const altLooksRight = /bed|room|bath|kitchen|pool|view|home|apartment|house|living/i.test(alt || "");
  return urlLooksRight || altLooksRight;
}

function dedupePhotos(photos) {
  const seen = new Set();
  const result = [];

  for (const photo of photos.sort((a, b) => b.score - a.score)) {
    const canonical = photo.url.split("?")[0];
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push({
      id: photo.id,
      index: result.length,
      url: photo.url,
      alt: photo.alt,
      width: photo.width,
      height: photo.height
    });
  }

  return result.slice(0, 8);
}

function extractAmenitiesPreview(text) {
  const amenityMatches = text.match(/wifi|workspace|parking|pool|kitchen|balcony|view|patio|hot tub|washer|dryer/gi) || [];
  return Array.from(new Set(amenityMatches.map((item) => item.toLowerCase()))).slice(0, 8);
}

function detectStructuredNightlyRate() {
  const metaPrice = document.querySelector('[itemprop="price"][content], meta[itemprop="price"][content]');
  const metaValue = parseMoney(metaPrice?.getAttribute("content"));
  if (metaValue) {
    return { value: metaValue, source: "structured" };
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const parsed = safeJsonParse(script.textContent);
    const offers = findOfferObjects(parsed);
    for (const offer of offers) {
      const priceValue = parseMoney(offer?.price ?? offer?.priceSpecification?.price);
      if (priceValue) {
        return { value: priceValue, source: "structured" };
      }
    }
  }

  return null;
}

function collectPriceTexts() {
  const texts = new Set();
  const bodyText = document.body?.innerText ?? "";
  if (bodyText) {
    texts.add(bodyText);
  }

  const selector = [
    '[data-testid*="price"]',
    '[data-testid*="book"]',
    '[aria-label*="$"]',
    '[class*="price"]'
  ].join(", ");

  for (const element of document.querySelectorAll(selector)) {
    const text = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("content")]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) {
      texts.add(text);
    }
  }

  return Array.from(texts);
}

function matchNightlyRate(text) {
  for (const pattern of NIGHTLY_RATE_PATTERNS) {
    const match = text.match(pattern);
    const value = parseMoney(match?.[1]);
    if (value) {
      return { value, source: "page" };
    }
  }

  return null;
}

function deriveNightlyRateFromTotal(textSources) {
  const stayNights = getStayNights();
  if (!stayNights) {
    return null;
  }

  for (const text of textSources) {
    for (const pattern of TOTAL_RATE_PATTERNS) {
      const match = text.match(pattern);
      const totalValue = parseMoney(match?.[1]);
      if (!totalValue) {
        continue;
      }

      const explicitNights = Number(match?.[2]);
      const divisor = explicitNights > 0 ? explicitNights : stayNights;
      if (!divisor) {
        continue;
      }

      return {
        value: Math.round(totalValue / divisor),
        source: "derived_total"
      };
    }
  }

  return null;
}

function getStayNights() {
  const params = new URLSearchParams(window.location.search);
  const checkIn = params.get("check_in");
  const checkOut = params.get("check_out");
  if (!checkIn || !checkOut) {
    return null;
  }

  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const milliseconds = end - start;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return null;
  }

  return Math.round(milliseconds / (1000 * 60 * 60 * 24));
}

function parseMoney(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value || "").replaceAll(",", "").trim();
  const match = text.match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findOfferObjects(value, results = []) {
  if (!value) {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findOfferObjects(item, results);
    }
    return results;
  }

  if (typeof value !== "object") {
    return results;
  }

  if (value.offers) {
    findOfferObjects(value.offers, results);
  }

  if (value.price || value.priceSpecification?.price) {
    results.push(value);
  }

  for (const nestedValue of Object.values(value)) {
    if (nestedValue && typeof nestedValue === "object") {
      findOfferObjects(nestedValue, results);
    }
  }

  return results;
}
