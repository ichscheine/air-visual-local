import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const AI_PROVIDER = normaliseProvider(process.env.AI_PROVIDER || "auto");
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5vl:3b";
const OLLAMA_VISION_MODELS = parseModelList(process.env.OLLAMA_VISION_MODELS || OLLAMA_MODEL);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const GEMINI_API_URL = (process.env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const USE_MOCK_AI = process.env.USE_MOCK_AI === "1";
const MAX_ANALYSIS_PHOTOS = clampInteger(process.env.MAX_ANALYSIS_PHOTOS, 3, 1, 6);
const PHOTO_FETCH_TIMEOUT_MS = clampInteger(process.env.PHOTO_FETCH_TIMEOUT_MS, 10000, 1000, 60000);
const OLLAMA_CHAT_TIMEOUT_MS = clampInteger(process.env.OLLAMA_CHAT_TIMEOUT_MS, 150000, 5000, 600000);
const GEMINI_TIMEOUT_MS = clampInteger(process.env.GEMINI_TIMEOUT_MS, 30000, 5000, 120000);
const OLLAMA_MIN_CONSENSUS = clampInteger(process.env.OLLAMA_MIN_CONSENSUS, 2, 1, 3);
const DEFAULT_OCCUPANCY = 0.62;
const MONTHLY_NIGHTS = 30;

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["listingSummary", "occupancyEstimate", "recommendations"],
  properties: {
    listingSummary: { type: "string" },
    occupancyEstimate: {
      type: "object",
      additionalProperties: false,
      required: ["value", "source"],
      properties: {
        value: { type: "number", minimum: 0.2, maximum: 0.95 },
        source: { type: "string", enum: ["page", "model_estimate", "default"] }
      }
    },
    recommendations: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "photoIndex",
          "category",
          "title",
          "problem",
          "action",
          "whyItMatters",
          "expectedLiftMin",
          "expectedLiftMax",
          "confidence",
          "roiScore",
          "editPlan"
        ],
        properties: {
          id: { type: "string" },
          photoIndex: { type: "integer", minimum: 0, maximum: 7 },
          category: {
            type: "string",
            enum: ["cover_photo", "brightness", "crop", "composition", "amenity_visibility", "sequence"]
          },
          title: { type: "string" },
          problem: { type: "string" },
          action: { type: "string" },
          whyItMatters: { type: "string" },
          expectedLiftMin: { type: "number", minimum: 0.5, maximum: 15 },
          expectedLiftMax: { type: "number", minimum: 0.5, maximum: 20 },
          confidence: { type: "number", minimum: 0.2, maximum: 0.95 },
          roiScore: { type: "integer", minimum: 1, maximum: 100 },
          editPlan: {
            type: "object",
            additionalProperties: false,
            required: ["mode", "brightness", "contrast", "saturation", "zoom", "focusX", "focusY", "note"],
            properties: {
              mode: { type: "string", enum: ["filter_crop", "sequence_only"] },
              brightness: { type: "number", minimum: 0.9, maximum: 1.2 },
              contrast: { type: "number", minimum: 0.9, maximum: 1.15 },
              saturation: { type: "number", minimum: 0.9, maximum: 1.1 },
              zoom: { type: "number", minimum: 1, maximum: 1.18 },
              focusX: { type: "number", minimum: 0, maximum: 100 },
              focusY: { type: "number", minimum: 0, maximum: 100 },
              note: { type: "string" }
            }
          }
        }
      }
    }
  }
};

const server = createServer(async (request, response) => {
  if (handleCors(request, response)) {
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const provider = getActiveProvider();
      sendJson(response, 200, {
        ok: true,
        mode: USE_MOCK_AI ? "demo" : provider,
        provider,
        model: getActiveModel(),
        ollamaUrl: OLLAMA_URL,
        geminiApiUrl: GEMINI_API_URL
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const status = await getRuntimeStatus();
      sendJson(response, 200, status);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readJson(request);
      validateListingPayload(body?.listing);
      await assertReadyForAnalysis();
      const analysis = await analyzeListing(body.listing);
      sendJson(response, 200, analysis);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Air Visual server listening on http://${HOST}:${PORT}`);
  console.log(`Mode: ${USE_MOCK_AI ? "demo" : `${getActiveProvider()} (${getActiveModel()})`}`);
});

function handleCors(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }

  return false;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function validateListingPayload(listing) {
  if (!listing || typeof listing !== "object") {
    throw new Error("Missing listing payload.");
  }
  if (!Array.isArray(listing.photos) || !listing.photos.length) {
    throw new Error("Listing photo candidates are required.");
  }
}

async function assertReadyForAnalysis() {
  if (USE_MOCK_AI) {
    return;
  }

  const status = await getRuntimeStatus();
  if (!status.ready) {
    throw new Error([status.message, Array.isArray(status.nextSteps) ? status.nextSteps[0] : ""].filter(Boolean).join(" "));
  }
}

async function analyzeListing(listing) {
  if (USE_MOCK_AI) {
    return buildMockAnalysis(listing);
  }

  const candidatePhotos = listing.photos.slice(0, getEffectiveMaxPhotos());
  const photosWithImageData = await fetchPhotosAsBase64(candidatePhotos);
  if (!photosWithImageData.length) {
    throw new Error("No listing photos could be fetched for vision analysis.");
  }

  if (getActiveProvider() === "gemini") {
    return enrichAnalysis(listing, await analyzeListingWithGemini(listing, photosWithImageData), GEMINI_MODEL);
  }

  const status = await getRuntimeStatus();
  const analysisModels = status.analysisModels?.length ? status.analysisModels : [OLLAMA_MODEL];
  const modelRuns = await Promise.allSettled(
    analysisModels.map(async (model) => ({
      model,
      analysis: await analyzeListingWithModel(model, listing, photosWithImageData)
    }))
  );
  const successfulRuns = modelRuns
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  if (!successfulRuns.length) {
    const firstFailure = modelRuns.find((result) => result.status === "rejected");
    throw firstFailure?.reason instanceof Error
      ? firstFailure.reason
      : new Error("All configured vision models failed.");
  }

  if (successfulRuns.length === 1) {
    return enrichAnalysis(listing, successfulRuns[0].analysis, successfulRuns[0].model);
  }

  return combineModelAnalyses(listing, successfulRuns, analysisModels);
}

async function fetchPhotosAsBase64(photos) {
  const results = await Promise.all(
    photos.map(async (photo) => {
      try {
        const response = await fetch(photo.url, {
          signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS)
        });
        if (!response.ok) {
          return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        const mimeType = normaliseImageMimeType(response.headers.get("content-type"));
        return {
          ...photo,
          mimeType,
          imageBase64: Buffer.from(arrayBuffer).toString("base64")
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

async function analyzeListingWithModel(model, listing, photosWithImageData) {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        format: ANALYSIS_SCHEMA,
        messages: [
          {
            role: "system",
            content: [
              "You are a careful Airbnb host photo strategist.",
              "Write short, decisive recommendations.",
              "Keep title, problem, action, and whyItMatters concise and concrete.",
              "Only recommend truthful, physically plausible Tier 1 photo improvements.",
              "Never fabricate amenities, furniture, materials, views, or room changes.",
              "Do not output placeholders like n/a, unknown, not available, none found, or raw numeric fragments."
            ].join(" ")
          },
          {
            role: "user",
            content: buildOllamaPrompt(listing, photosWithImageData, model),
            images: photosWithImageData.map((photo) => photo.imageBase64)
          }
        ],
        options: {
          temperature: 0.2
        }
      }),
      signal: AbortSignal.timeout(getModelChatTimeoutMs(model))
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`${model} timed out during analysis.`);
    }
    throw error;
  }

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `${model} analysis request failed.`);
  }

  const content = result.message?.content;
  return typeof content === "string" ? JSON.parse(content) : content;
}

async function analyzeListingWithGemini(listing, photosWithImageData) {
  let response;
  try {
    response = await fetch(`${GEMINI_API_URL}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildGeminiPrompt(listing, photosWithImageData) },
            ...photosWithImageData.map((photo) => ({
              inline_data: {
                mime_type: photo.mimeType,
                data: photo.imageBase64
              }
            }))
          ]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: ANALYSIS_SCHEMA
        }
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`${GEMINI_MODEL} timed out during analysis.`);
    }
    throw error;
  }

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `${GEMINI_MODEL} analysis request failed.`);
  }

  const text = getGeminiResponseText(result);
  return JSON.parse(text);
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normaliseProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return ["auto", "ollama", "gemini"].includes(provider) ? provider : "auto";
}

function getActiveProvider() {
  if (USE_MOCK_AI) {
    return "demo";
  }

  if (AI_PROVIDER === "gemini") {
    return "gemini";
  }

  if (AI_PROVIDER === "ollama") {
    return "ollama";
  }

  return GEMINI_API_KEY ? "gemini" : "ollama";
}

function getActiveModel() {
  return getActiveProvider() === "gemini" ? GEMINI_MODEL : OLLAMA_MODEL;
}

function modelNameMatches(installedName, requestedName) {
  const installed = String(installedName || "").trim().toLowerCase();
  const requested = String(requestedName || "").trim().toLowerCase();
  if (!installed || !requested) {
    return false;
  }
  return installed === requested || installed === `${requested}:latest`;
}

function parseModelList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredVisionModels() {
  const models = OLLAMA_VISION_MODELS.length ? OLLAMA_VISION_MODELS : [OLLAMA_MODEL];
  return Array.from(new Set(models.filter((model) => isVisionModel(model))));
}

function getAvailableAnalysisModels(installedNames) {
  return getConfiguredVisionModels().filter((model) =>
    installedNames.some((installedName) => modelNameMatches(installedName, model))
  );
}

function isVisionModel(model) {
  return /(moondream|qwen2\.5vl|llava|bakllava|minicpm-v|gemma3)/i.test(String(model || ""));
}

function getModelChatTimeoutMs(model) {
  if (/qwen2\.5vl:7b/i.test(model)) {
    return Math.min(OLLAMA_CHAT_TIMEOUT_MS, 90000);
  }

  if (/qwen2\.5vl:3b/i.test(model)) {
    return Math.min(OLLAMA_CHAT_TIMEOUT_MS, 75000);
  }

  if (/moondream/i.test(model)) {
    return Math.min(OLLAMA_CHAT_TIMEOUT_MS, 45000);
  }

  return OLLAMA_CHAT_TIMEOUT_MS;
}

function getEffectiveMaxPhotos() {
  if (getActiveProvider() === "gemini") {
    return MAX_ANALYSIS_PHOTOS;
  }

  return isFastVisionModel() ? Math.max(2, Math.min(MAX_ANALYSIS_PHOTOS, 2)) : MAX_ANALYSIS_PHOTOS;
}

function isFastVisionModel(model = OLLAMA_MODEL) {
  return /^moondream(?::|$)/i.test(model);
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || /signal timed out|aborted due to timeout/i.test(error?.message || "");
}

function buildOllamaPrompt(listing, photos, model = OLLAMA_MODEL) {
  const recommendationLimit = isFastVisionModel(model) ? 3 : 5;
  const photoSummary = photos
    .map((photo, index) => {
      const parts = [`Photo ${index}: sourceIndex=${photo.index}`, `size=${photo.width}x${photo.height}`];
      if (photo.alt) {
        parts.splice(1, 0, `alt="${photo.alt}"`);
      }
      return parts.join(", ");
    })
    .join("\n");

  return [
    "Evaluate these Airbnb listing photos for immediate visual wins only.",
    `Return no more than ${recommendationLimit} recommendations.`,
    "Use blunt, specific language. No filler, no hedging, no repeated context.",
    "Only recommend: better cover choice, brighter lighting, safer crop, stronger composition, clearer amenity visibility, or better sequencing.",
    "Use cover_photo only when a different source photo should become the hero image.",
    "Each recommendation must map to a source photo index.",
    "Prefer distinct recommendations. Do not return multiple near-duplicate visual edits for the same source photo.",
    "If two ideas overlap on the same photo, keep only the single strongest recommendation.",
    "The editPlan must stay subtle and truthful.",
    "Use mode=sequence_only for sequence recommendations and keep all edit controls neutral in that case.",
    isFastVisionModel(model) ? "Focus on obvious hero-photo issues only. Prioritize basic lighting, crop, and composition fixes." : null,
    `Listing title: ${listing.title}`,
    (listing.amenitiesPreview || []).length ? `Amenities preview: ${listing.amenitiesPreview.join(", ")}` : null,
    "Photo order and metadata:",
    photoSummary
  ].filter(Boolean).join("\n");
}

function buildGeminiPrompt(listing, photos) {
  return [
    "You are a careful Airbnb host photo strategist.",
    "Write short, decisive recommendations.",
    "Keep title, problem, action, and whyItMatters concise and concrete.",
    "Only recommend truthful, physically plausible Tier 1 photo improvements.",
    "Never fabricate amenities, furniture, materials, views, or room changes.",
    "Do not output placeholders like n/a, unknown, not available, none found, or raw numeric fragments.",
    buildOllamaPrompt(listing, photos, GEMINI_MODEL)
  ].join("\n");
}

async function getRuntimeStatus() {
  if (USE_MOCK_AI) {
    const analysisModels = getConfiguredVisionModels();
    return {
      ok: true,
      mode: "demo",
      provider: "demo",
      ollamaUrl: OLLAMA_URL,
      geminiApiUrl: GEMINI_API_URL,
      model: getActiveModel(),
      analysisModels,
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ollamaReachable: false,
      modelInstalled: false,
      ready: true,
      message: "Demo mode enabled.",
      nextSteps: [
        "Set USE_MOCK_AI=0 to use Ollama.",
        `Install Ollama and pull ${OLLAMA_MODEL} when you want live analysis.`
      ]
    };
  }

  if (getActiveProvider() === "gemini") {
    return getGeminiRuntimeStatus();
  }

  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) {
      return {
        ok: false,
        mode: "ollama",
        ollamaUrl: OLLAMA_URL,
        model: OLLAMA_MODEL,
        ollamaReachable: false,
        modelInstalled: false,
        ready: false,
        message: `Ollama responded with status ${response.status}.`,
        nextSteps: [
          "Start the Ollama server.",
          `Then run: ollama pull ${OLLAMA_MODEL}`
        ]
      };
    }

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const installedNames = models.map((item) => item.model || item.name).filter(Boolean);
    const modelInstalled = installedNames.some((name) => modelNameMatches(name, OLLAMA_MODEL));
    const analysisModels = getAvailableAnalysisModels(installedNames);

    return {
      ok: true,
      mode: "ollama",
      provider: "ollama",
      ollamaUrl: OLLAMA_URL,
      geminiApiUrl: GEMINI_API_URL,
      model: OLLAMA_MODEL,
      analysisModels,
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ollamaReachable: true,
      modelInstalled,
      ready: analysisModels.length > 0,
      installedModels: installedNames,
      message: analysisModels.length
        ? `Ollama is ready with ${analysisModels.join(", ")}.`
        : `Ollama is reachable, but no configured vision models are installed.`,
      nextSteps: analysisModels.length
        ? ["Scan the current listing."]
        : [`Run: ollama pull ${getConfiguredVisionModels()[0] || OLLAMA_MODEL}`]
    };
  } catch (error) {
    return {
      ok: false,
      mode: "ollama",
      provider: "ollama",
      ollamaUrl: OLLAMA_URL,
      geminiApiUrl: GEMINI_API_URL,
      model: OLLAMA_MODEL,
      analysisModels: [],
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ollamaReachable: false,
      modelInstalled: false,
      ready: false,
      message: `Could not reach Ollama at ${OLLAMA_URL}.`,
      nextSteps: [
        "Install and start Ollama.",
        `Then run: ollama pull ${OLLAMA_MODEL}`
      ],
      error: error.message
    };
  }
}

async function getGeminiRuntimeStatus() {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      mode: "gemini",
      provider: "gemini",
      model: GEMINI_MODEL,
      geminiApiUrl: GEMINI_API_URL,
      analysisModels: [],
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ready: false,
      geminiReachable: false,
      message: "Gemini is selected, but GEMINI_API_KEY is missing.",
      nextSteps: [
        "Get a free Gemini API key from Google AI Studio.",
        "Set GEMINI_API_KEY in .env, then restart npm run dev."
      ]
    };
  }

  try {
    const response = await fetch(`${GEMINI_API_URL}/models/${encodeURIComponent(GEMINI_MODEL)}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "GET",
      signal: AbortSignal.timeout(4000)
    });
    const result = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        mode: "gemini",
        provider: "gemini",
        model: GEMINI_MODEL,
        geminiApiUrl: GEMINI_API_URL,
        analysisModels: [],
        maxAnalysisPhotos: getEffectiveMaxPhotos(),
        ready: false,
        geminiReachable: false,
        message: result.error?.message || `Gemini responded with status ${response.status}.`,
        nextSteps: [
          "Verify GEMINI_API_KEY and GEMINI_MODEL in .env.",
          "Confirm the key has access to the Gemini Developer API free tier."
        ]
      };
    }

    return {
      ok: true,
      mode: "gemini",
      provider: "gemini",
      model: GEMINI_MODEL,
      geminiApiUrl: GEMINI_API_URL,
      analysisModels: [GEMINI_MODEL],
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ready: true,
      geminiReachable: true,
      message: `Gemini is ready with ${GEMINI_MODEL}.`,
      nextSteps: ["Scan the current listing."],
      modelInfo: {
        name: result.name,
        displayName: result.displayName
      }
    };
  } catch (error) {
    return {
      ok: false,
      mode: "gemini",
      provider: "gemini",
      model: GEMINI_MODEL,
      geminiApiUrl: GEMINI_API_URL,
      analysisModels: [],
      maxAnalysisPhotos: getEffectiveMaxPhotos(),
      ready: false,
      geminiReachable: false,
      message: `Could not reach Gemini at ${GEMINI_API_URL}.`,
      nextSteps: [
        "Check your internet connection.",
        "Verify GEMINI_API_KEY and restart npm run dev."
      ],
      error: error.message
    };
  }
}

function getGeminiResponseText(result) {
  const text = result?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error(`${GEMINI_MODEL} returned no text content.`);
  }

  return text;
}

function normaliseImageMimeType(value) {
  const mimeType = String(value || "").split(";")[0].trim().toLowerCase();
  return mimeType.startsWith("image/") ? mimeType : "image/jpeg";
}

function buildMockAnalysis(listing) {
  const occupancyValue = listing.occupancyEstimate?.value || DEFAULT_OCCUPANCY;

  return enrichAnalysis(listing, {
    listingSummary: "Demo mode: the first image appears to carry the most weight, while later photos likely need stronger light balance and a clearer amenity story.",
    occupancyEstimate: {
      value: occupancyValue,
      source: listing.occupancyEstimate?.value ? "page" : "default"
    },
    recommendations: [
      {
        id: "hero-brightness",
        photoIndex: 0,
        category: "cover_photo",
        title: "Brighten the hero image and tighten the crop",
        problem: "The cover photo likely has the most booking leverage, but if it reads dark or wide, it can undersell the room immediately.",
        action: "Use a brighter crop that centers the bed, window light, or strongest focal point without changing the room.",
        whyItMatters: "Hosts win more clicks when the first image feels bright, legible, and emotionally clear.",
        expectedLiftMin: 2.5,
        expectedLiftMax: 6,
        confidence: 0.72,
        roiScore: 88,
        editPlan: {
          mode: "filter_crop",
          brightness: 1.12,
          contrast: 1.04,
          saturation: 1.02,
          zoom: 1.08,
          focusX: 52,
          focusY: 46,
          note: "Slightly brighter exposure with a tighter focal crop around the strongest room feature."
        }
      },
      {
        id: "amenity-visibility",
        photoIndex: Math.min(1, listing.photos.length - 1),
        category: "amenity_visibility",
        title: "Make the key amenity more obvious",
        problem: "Important selling features often get lost if the frame is too wide or the eye has no focal hierarchy.",
        action: "Highlight the most bookable feature in the frame, such as workspace, tub, balcony, or natural light.",
        whyItMatters: "Clear amenity storytelling helps guests understand value faster.",
        expectedLiftMin: 1.5,
        expectedLiftMax: 4,
        confidence: 0.64,
        roiScore: 73,
        editPlan: {
          mode: "filter_crop",
          brightness: 1.08,
          contrast: 1.03,
          saturation: 1.04,
          zoom: 1.12,
          focusX: 58,
          focusY: 50,
          note: "Crop toward the real amenity and make the light balance slightly cleaner."
        }
      },
      {
        id: "sequence-fix",
        photoIndex: Math.min(2, listing.photos.length - 1),
        category: "sequence",
        title: "Move the most legible room shot earlier in the sequence",
        problem: "If later photos explain the space better than earlier ones, guests may bounce before they understand the listing.",
        action: "Promote the clearest, brightest room shot earlier in the photo order.",
        whyItMatters: "A stronger narrative in the first few photos improves trust and scanning speed.",
        expectedLiftMin: 1,
        expectedLiftMax: 2.5,
        confidence: 0.58,
        roiScore: 61,
        editPlan: {
          mode: "sequence_only",
          brightness: 1,
          contrast: 1,
          saturation: 1,
          zoom: 1,
          focusX: 50,
          focusY: 50,
          note: "No pixel change. This recommendation is about photo order only."
        }
      }
    ]
  });
}

function enrichAnalysis(listing, analysis, model = OLLAMA_MODEL) {
  const nightlyRate = listing.nightlyRate?.value || 0;
  const occupancyValue = clamp(
    analysis.occupancyEstimate?.value ?? listing.occupancyEstimate?.value ?? DEFAULT_OCCUPANCY,
    0.2,
    0.95
  );
  const occupancySource = analysis.occupancyEstimate?.source || (listing.occupancyEstimate?.value ? "page" : "default");
  const monthlyBaseRevenue = nightlyRate * occupancyValue * MONTHLY_NIGHTS;
  const distinctRecommendations = pruneDuplicateRecommendations(
    (analysis.recommendations || []).map((recommendation) => normaliseRecommendation(recommendation, listing, model))
  );
  const enrichedRecommendations = distinctRecommendations.map((normalisedRecommendation) => {
    const coverPhotoTargetIndex = getCoverPhotoTargetIndex(normalisedRecommendation, listing);
    const sequenceTargetIndex = getSequenceTargetIndex(normalisedRecommendation, listing);
    const recommendationPhoto = getRecommendationPhoto(listing, normalisedRecommendation, coverPhotoTargetIndex);
    const projectedMonthlyRevenueLiftMin = roundCurrency(monthlyBaseRevenue * (normalisedRecommendation.expectedLiftMin / 100));
    const projectedMonthlyRevenueLiftMax = roundCurrency(monthlyBaseRevenue * (normalisedRecommendation.expectedLiftMax / 100));
    const sanitisedEditPlan = sanitiseEditPlan(normalisedRecommendation.editPlan, normalisedRecommendation.category, recommendationPhoto);
    const priorityValue = calculatePriorityValue(normalisedRecommendation, projectedMonthlyRevenueLiftMin, projectedMonthlyRevenueLiftMax);
    const normalisedAction = normalisedRecommendation.category === "cover_photo"
      ? buildCoverPhotoAction(normalisedRecommendation, coverPhotoTargetIndex)
      : normalisedRecommendation.category === "sequence"
        ? buildSequenceAction(normalisedRecommendation, sequenceTargetIndex)
        : buildActionForCategory(normalisedRecommendation, sanitisedEditPlan);

    return {
      ...normalisedRecommendation,
      categoryLabel: formatCategory(normalisedRecommendation.category),
      coverPhotoTargetIndex,
      sequenceTargetIndex,
      action: normalisedAction,
      editPlan: sanitisedEditPlan,
      projectedMonthlyRevenueLiftMin,
      projectedMonthlyRevenueLiftMax,
      priorityValue
    };
  });

  const sortedRecommendations = enrichedRecommendations
    .filter((recommendation) => hasMeaningfulRecommendationChange(recommendation))
    .slice()
    .sort((a, b) => b.priorityValue - a.priorityValue || b.confidence - a.confidence || b.expectedLiftMax - a.expectedLiftMax)
    .map((recommendation, index) => ({
      ...recommendation,
      priorityRank: index + 1
    }));

  return {
    listingSummary: analysis.listingSummary,
    occupancyEstimate: {
      value: occupancyValue,
      source: occupancySource
    },
    recommendations: sortedRecommendations
  };
}

function combineModelAnalyses(listing, modelRuns, analysisModels) {
  const enrichedRuns = modelRuns.map((run) => ({
    model: run.model,
    analysis: enrichAnalysis(listing, run.analysis, run.model)
  }));
  const voteThreshold = Math.min(Math.max(OLLAMA_MIN_CONSENSUS, 2), enrichedRuns.length);
  const groupedRecommendations = new Map();

  for (const run of enrichedRuns) {
    for (const recommendation of run.analysis.recommendations) {
      const key = getConsensusRecommendationKey(recommendation);
      const existing = groupedRecommendations.get(key);
      if (!existing) {
        groupedRecommendations.set(key, {
          key,
          votes: 1,
          models: new Set([run.model]),
          representative: recommendation,
          priorityTotal: recommendation.priorityValue || 0
        });
        continue;
      }

      if (!existing.models.has(run.model)) {
        existing.votes += 1;
        existing.models.add(run.model);
      }

      existing.priorityTotal += recommendation.priorityValue || 0;
      if (compareRecommendationStrength(recommendation, existing.representative) < 0) {
        existing.representative = recommendation;
      }
    }
  }

  const consensusRecommendations = Array.from(groupedRecommendations.values())
    .filter((group) => group.votes >= voteThreshold)
    .sort((a, b) =>
      b.votes - a.votes
      || b.priorityTotal - a.priorityTotal
      || (b.representative.confidence || 0) - (a.representative.confidence || 0)
    )
    .slice(0, 5)
    .map((group, index) => ({
      ...group.representative,
      consensusVotes: group.votes,
      supportingModels: Array.from(group.models),
      priorityRank: index + 1
    }));

  if (!consensusRecommendations.length) {
    return {
      listingSummary: "No recommendation cleared the multi-model vote threshold.",
      occupancyEstimate: selectConsensusOccupancy(enrichedRuns),
      recommendations: []
    };
  }

  const preferredRun = selectPreferredModelRun(enrichedRuns, analysisModels);
  return {
    listingSummary: preferredRun?.analysis?.listingSummary || "",
    occupancyEstimate: selectConsensusOccupancy(enrichedRuns),
    recommendations: consensusRecommendations
  };
}

function pruneDuplicateRecommendations(recommendations) {
  const distinct = new Map();

  for (const recommendation of recommendations) {
    const key = getRecommendationDistinctKey(recommendation);
    const existing = distinct.get(key);
    if (!existing || compareRecommendationStrength(recommendation, existing) < 0) {
      distinct.set(key, recommendation);
    }
  }

  return Array.from(distinct.values());
}

function getRecommendationDistinctKey(recommendation) {
  if (recommendation.category === "sequence") {
    return `sequence:${recommendation.photoIndex}`;
  }

  return `photo:${recommendation.photoIndex}`;
}

function compareRecommendationStrength(left, right) {
  const leftScore = getRecommendationStrengthScore(left);
  const rightScore = getRecommendationStrengthScore(right);
  return rightScore - leftScore;
}

function getRecommendationStrengthScore(recommendation) {
  const confidence = clamp(recommendation.confidence ?? 0.5, 0.2, 0.95);
  const liftMid = ((recommendation.expectedLiftMin || 0) + (recommendation.expectedLiftMax || 0)) / 2;
  return liftMid * confidence * getCategoryWeight(recommendation.category);
}

function getConsensusRecommendationKey(recommendation) {
  if (recommendation.category === "sequence") {
    return `sequence:${recommendation.photoIndex}:${recommendation.sequenceTargetIndex ?? "none"}`;
  }

  if (recommendation.category === "cover_photo") {
    return `cover:${recommendation.coverPhotoTargetIndex ?? "none"}`;
  }

  return `edit:${recommendation.photoIndex}`;
}

function selectPreferredModelRun(enrichedRuns, analysisModels) {
  for (const model of analysisModels) {
    const match = enrichedRuns.find((run) => modelNameMatches(run.model, model));
    if (match) {
      return match;
    }
  }

  return enrichedRuns[0] || null;
}

function selectConsensusOccupancy(enrichedRuns) {
  if (!enrichedRuns.length) {
    return { value: DEFAULT_OCCUPANCY, source: "default" };
  }

  const total = enrichedRuns.reduce((sum, run) => sum + (run.analysis.occupancyEstimate?.value || DEFAULT_OCCUPANCY), 0);
  return {
    value: clamp(total / enrichedRuns.length, 0.2, 0.95),
    source: "model_estimate"
  };
}

function normaliseRecommendation(recommendation, listing, model = OLLAMA_MODEL) {
  if (recommendation.category !== "cover_photo") {
    return recommendation;
  }

  const coverPhotoTargetIndex = getCoverPhotoTargetIndex(recommendation, listing);
  if (coverPhotoTargetIndex > 0 && shouldAllowCoverPhotoReplacement(recommendation, listing, model)) {
    return recommendation;
  }

  const downgradedCategory = inferSameHeroCategory(recommendation.editPlan);
  return {
    ...recommendation,
    category: downgradedCategory,
    title: "",
    action: "",
    whyItMatters: cleanRecommendationText(recommendation.whyItMatters)
  };
}

function shouldAllowCoverPhotoReplacement(recommendation, listing, model = OLLAMA_MODEL) {
  const coverPhotoTargetIndex = getCoverPhotoTargetIndex(recommendation, listing);
  if (!(coverPhotoTargetIndex > 0)) {
    return false;
  }

  if (isFastVisionModel(model)) {
    return false;
  }

  if ((listing.photos?.length || 0) < 4) {
    return false;
  }

  const confidence = clamp(recommendation.confidence ?? 0.5, 0.2, 0.95);
  return confidence >= 0.75 && (recommendation.expectedLiftMax || 0) >= 3;
}

function sanitiseEditPlan(editPlan, category, photo) {
  if (!editPlan || typeof editPlan !== "object") {
    return defaultEditPlanForCategory(category, undefined, photo);
  }

  const isSequence = category === "sequence" || editPlan.mode === "sequence_only";
  if (category === "sequence") {
    return neutralEditPlan(true, editPlan.note);
  }

  if (isSequence) {
    return defaultEditPlanForCategory(category, editPlan.note, photo);
  }

  const sanitised = {
    mode: "filter_crop",
    brightness: clamp(editPlan.brightness ?? 1.05, 0.9, 1.2),
    contrast: clamp(editPlan.contrast ?? 1.02, 0.9, 1.15),
    saturation: clamp(editPlan.saturation ?? 1.01, 0.9, 1.1),
    zoom: clamp(editPlan.zoom ?? 1.05, 1, 1.18),
    focusX: clamp(editPlan.focusX ?? 50, 0, 100),
    focusY: clamp(editPlan.focusY ?? 50, 0, 100),
    note: cleanRecommendationText(editPlan.note) || "Subtle crop and light cleanup."
  };

  return hasVisibleEditPlanChange(sanitised)
    ? sanitised
    : defaultEditPlanForCategory(category, sanitised.note, photo);
}

function defaultEditPlanForCategory(category, note, photo) {
  if (category === "sequence") {
    return neutralEditPlan(true, note);
  }

  return buildPhotoSpecificFallbackEditPlan(category, photo, note);
}

function neutralEditPlan(isSequenceOnly, note) {
  return {
    mode: isSequenceOnly ? "sequence_only" : "filter_crop",
    brightness: 1,
    contrast: 1,
    saturation: 1,
    zoom: 1,
    focusX: 50,
    focusY: 50,
    note: cleanRecommendationText(note) || (isSequenceOnly ? "Sequence change only." : "Subtle crop and light cleanup.")
  };
}

function formatCategory(category) {
  return category.replaceAll("_", " ");
}

function calculatePriorityValue(recommendation, projectedMin, projectedMax) {
  const confidence = clamp(recommendation.confidence ?? 0.5, 0.2, 0.95);
  const liftMid = ((recommendation.expectedLiftMin || 0) + (recommendation.expectedLiftMax || 0)) / 2;
  const impactMid = (projectedMin + projectedMax) / 2;
  const categoryWeight = getCategoryWeight(recommendation.category);
  const impactComponent = impactMid > 0 ? impactMid : liftMid * 20;

  return impactComponent * confidence * categoryWeight;
}

function getCategoryWeight(category) {
  switch (category) {
    case "cover_photo":
      return 1.15;
    case "amenity_visibility":
      return 1.05;
    case "sequence":
      return 0.85;
    default:
      return 1;
  }
}

function getCoverPhotoTargetIndex(recommendation, listing) {
  if (recommendation.category !== "cover_photo") {
    return null;
  }

  const maxIndex = Math.max(0, (listing.photos?.length || 1) - 1);
  return clamp(Number(recommendation.photoIndex) || 0, 0, maxIndex);
}

function buildCoverPhotoAction(recommendation, targetIndex) {
  const editSuffix = recommendation.editPlan?.mode === "filter_crop"
    ? " Then apply the suggested crop and light cleanup."
    : "";

  if (targetIndex > 0) {
    return `Replace the current hero image with photo ${targetIndex + 1}.${editSuffix}`;
  }

  return "Choose a stronger replacement hero image.";
}

function buildActionForCategory(recommendation, editPlan) {
  const cleanedAction = cleanRecommendationText(recommendation.action);
  if (cleanedAction) {
    return cleanedAction;
  }

  switch (recommendation.category) {
    case "brightness":
      return "Lift the light slightly without changing the room.";
    case "crop":
      return "Tighten the crop so the focal point lands faster.";
    case "composition":
      return hasVisibleCropShift(editPlan)
        ? "Reframe the image around the strongest focal point."
        : "Clean up the framing so the image reads faster.";
    case "amenity_visibility":
      return "Crop closer so the key amenity reads immediately.";
    case "sequence":
      return buildSequenceAction(recommendation, recommendation.sequenceTargetIndex);
    default:
      return "Refine this photo.";
  }
}

function inferSameHeroCategory(editPlan) {
  if (hasVisibleCropShift(editPlan)) {
    return "crop";
  }

  if (hasVisibleLightChange(editPlan)) {
    return "brightness";
  }

  return "composition";
}

function hasVisibleCropShift(editPlan) {
  if (!editPlan || editPlan.mode === "sequence_only") {
    return false;
  }

  return (editPlan.zoom ?? 1) > 1.01
    || Math.abs((editPlan.focusX ?? 50) - 50) >= 4
    || Math.abs((editPlan.focusY ?? 50) - 50) >= 4;
}

function hasVisibleLightChange(editPlan) {
  if (!editPlan || editPlan.mode === "sequence_only") {
    return false;
  }

  return Math.abs((editPlan.brightness ?? 1) - 1) >= 0.02
    || Math.abs((editPlan.contrast ?? 1) - 1) >= 0.02
    || Math.abs((editPlan.saturation ?? 1) - 1) >= 0.02;
}

function getSequenceTargetIndex(recommendation, listing) {
  if (recommendation.category !== "sequence") {
    return null;
  }

  const currentIndex = clamp(Number(recommendation.photoIndex) || 0, 0, Math.max(0, (listing.photos?.length || 1) - 1));
  if (currentIndex === 0) {
    return null;
  }

  if (currentIndex === 1) {
    return 0;
  }

  return 1;
}

function getRecommendationPhoto(listing, recommendation, coverPhotoTargetIndex) {
  if (recommendation.category === "cover_photo" && typeof coverPhotoTargetIndex === "number") {
    return listing.photos?.find((item) => item.index === coverPhotoTargetIndex) || listing.photos?.[0] || null;
  }

  return listing.photos?.find((item) => item.index === recommendation.photoIndex) || listing.photos?.[0] || null;
}

function buildSequenceAction(recommendation, targetIndex) {
  if (targetIndex == null) {
    return "Keep the current order.";
  }

  const currentSlot = Number(recommendation.photoIndex) + 1;
  const targetSlot = Number(targetIndex) + 1;

  if (targetSlot === 1) {
    return `Move photo ${currentSlot} into slot 1 so guests see it first.`;
  }

  return `Move photo ${currentSlot} into slot ${targetSlot}, directly after the hero image.`;
}

function hasMeaningfulRecommendationChange(recommendation) {
  if (recommendation.category === "sequence") {
    return typeof recommendation.sequenceTargetIndex === "number"
      && recommendation.sequenceTargetIndex !== recommendation.photoIndex;
  }

  if (recommendation.category === "cover_photo") {
    return recommendation.coverPhotoTargetIndex > 0;
  }

  return hasVisibleEditPlanChange(recommendation.editPlan);
}

function hasVisibleEditPlanChange(editPlan) {
  if (!editPlan || editPlan.mode === "sequence_only") {
    return false;
  }

  return Math.abs((editPlan.brightness ?? 1) - 1) >= 0.02
    || Math.abs((editPlan.contrast ?? 1) - 1) >= 0.02
    || Math.abs((editPlan.saturation ?? 1) - 1) >= 0.02
    || (editPlan.zoom ?? 1) > 1.01
    || Math.abs((editPlan.focusX ?? 50) - 50) >= 4
    || Math.abs((editPlan.focusY ?? 50) - 50) >= 4;
}

function buildPhotoSpecificFallbackEditPlan(category, photo, note) {
  const width = Math.max(1, Number(photo?.width) || 1200);
  const height = Math.max(1, Number(photo?.height) || 900);
  const aspectRatio = width / height;
  const isPortrait = aspectRatio < 0.95;
  const isWide = aspectRatio > 1.3;

  const categoryBase = getFallbackCategoryBase(category);
  const brightness = clamp(categoryBase.brightness + (isWide ? 0.01 : 0) + (isPortrait ? 0.01 : 0), 0.9, 1.2);
  const contrast = clamp(categoryBase.contrast + (isWide ? 0.01 : 0), 0.9, 1.15);
  const saturation = clamp(categoryBase.saturation + (isPortrait ? 0.01 : 0), 0.9, 1.1);
  const zoom = clamp(categoryBase.zoom + (isPortrait ? 0.03 : isWide ? 0.01 : 0.02), 1, 1.18);
  const focusX = clamp(categoryBase.focusX + (isWide ? 2 : 0), 0, 100);
  const focusY = clamp(categoryBase.focusY + (isPortrait ? -6 : isWide ? -3 : -1), 0, 100);

  return {
    mode: "filter_crop",
    brightness,
    contrast,
    saturation,
    zoom,
    focusX,
    focusY,
    note: note || buildFallbackEditNote(category, isPortrait, isWide)
  };
}

function getFallbackCategoryBase(category) {
  switch (category) {
    case "cover_photo":
      return { brightness: 1.05, contrast: 1.02, saturation: 1.01, zoom: 1.03, focusX: 50, focusY: 48 };
    case "brightness":
      return { brightness: 1.06, contrast: 1.01, saturation: 1, zoom: 1.01, focusX: 50, focusY: 50 };
    case "crop":
      return { brightness: 1.02, contrast: 1.01, saturation: 1, zoom: 1.05, focusX: 50, focusY: 48 };
    case "composition":
      return { brightness: 1.03, contrast: 1.02, saturation: 1.01, zoom: 1.04, focusX: 50, focusY: 47 };
    case "amenity_visibility":
      return { brightness: 1.04, contrast: 1.02, saturation: 1.02, zoom: 1.06, focusX: 54, focusY: 50 };
    default:
      return { brightness: 1.03, contrast: 1.01, saturation: 1.01, zoom: 1.03, focusX: 50, focusY: 50 };
  }
}

function buildFallbackEditNote(category, isPortrait, isWide) {
  const frameDescriptor = isPortrait ? "portrait frame" : isWide ? "wide frame" : "balanced frame";

  switch (category) {
    case "cover_photo":
      return `Tighten the ${frameDescriptor} and lift the light slightly.`;
    case "amenity_visibility":
      return `Crop closer to the key feature and clean up the light in this ${frameDescriptor}.`;
    case "brightness":
      return "Add light cleanup without changing the room.";
    default:
      return `Subtle crop and light cleanup for this ${frameDescriptor}.`;
  }
}

function cleanRecommendationText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^preview only:\s*/i, "")
    .replace(/\b(?:n\/a|not available|unknown|none found)\b/gi, "")
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundCurrency(value) {
  return Math.round(value);
}
