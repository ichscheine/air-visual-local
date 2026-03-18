const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
const MESSAGE_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 5000;
const ANALYSIS_TIMEOUT_MS = 180000;

const elements = {
  status: document.getElementById("status"),
  recommendations: document.getElementById("recommendations"),
  template: document.getElementById("recommendation-template"),
  emptyStateTemplate: document.getElementById("empty-state-template")
};

const state = {
  listing: null,
  analysis: null,
  backendUrl: DEFAULT_BACKEND_URL,
  runtimeStatus: null,
  isScanning: false
};

init();

async function init() {
  await analyzeCurrentListing();
}

async function analyzeCurrentListing() {
  if (state.isScanning) {
    return;
  }

  state.isScanning = true;
  clearRecommendations();
  setStatus("Scanning the current Airbnb listing...", "loading");

  try {
    const runtimeStatus = await refreshRuntimeStatus();
    if (!runtimeStatus?.ready) {
      const nextStep = Array.isArray(runtimeStatus?.nextSteps) ? runtimeStatus.nextSteps[0] : "";
      setStatus([runtimeStatus?.message, nextStep].filter(Boolean).join(" "), "error");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("airbnb.")) {
      setStatus("Open an Airbnb listing or host photo page first.", "error");
      return;
    }

    const listing = await sendMessageWithTimeout(tab.id, { type: "AIR_VISUAL_EXTRACT_LISTING" }, MESSAGE_TIMEOUT_MS);
    if (!listing?.ok) {
      setStatus(listing?.error || "Could not extract listing context from the current page.", "error");
      return;
    }

    if (!listing.photos?.length) {
      setStatus("The page loaded, but no listing photos were detected.", "error");
      return;
    }

    state.listing = listing;
    const maxAnalysisPhotos = Number(runtimeStatus?.maxAnalysisPhotos) || listing.photos.length;
    const photoCountToAnalyze = Math.min(listing.photos.length, maxAnalysisPhotos);
    const analysisMessage = photoCountToAnalyze >= listing.photos.length
      ? `Analyzing ${photoCountToAnalyze} photos...`
      : `Analyzing ${photoCountToAnalyze} of ${listing.photos.length} photos for the first pass...`;
    setStatus(analysisMessage, "loading");

    const analysis = await callApi("/api/analyze", { listing });
    state.analysis = analysis;
    if (!analysis.recommendations?.length) {
      renderEmptyState();
      setStatus("No strong quick wins found. The current photo set can stay as-is for now.");
      return;
    }

    renderRecommendations(listing, analysis);
    clearStatus();
  } catch (error) {
    clearRecommendations();
    setStatus(error.message || "Analysis failed.", "error");
  } finally {
    state.isScanning = false;
  }
}

function clearRecommendations() {
  elements.recommendations.innerHTML = "";
}

function renderEmptyState() {
  clearRecommendations();
  const fragment = elements.emptyStateTemplate.content.cloneNode(true);
  elements.recommendations.appendChild(fragment);
}

function renderRecommendations(listing, analysis) {
  clearRecommendations();

  for (const recommendation of analysis.recommendations) {
    const fragment = elements.template.content.cloneNode(true);
    const card = fragment.querySelector(".recommendation");
    const recommendationPhotos = getRecommendationPhotos(listing, recommendation);
    const decisionKey = buildDecisionKey(listing, recommendation);
    const analysisSummary = fragment.querySelector(".analysis-summary");
    const topRationale = fragment.querySelector(".top-rationale");
    const topRationaleText = fragment.querySelector(".top-rationale-text");
    const variantImage = fragment.querySelector(".variant-image");
    const placeholder = fragment.querySelector(".variant-placeholder");
    const acceptButton = fragment.querySelector(".accept-button");
    const declineButton = fragment.querySelector(".decline-button");
    const decisionStatus = fragment.querySelector(".decision-status");
    const beforeCaption = fragment.querySelector(".before-caption");
    const previewCaption = fragment.querySelector(".preview-caption");
    const issueElement = fragment.querySelector(".issue");
    const whyElement = fragment.querySelector(".why");
    const impactLine = fragment.querySelector(".impact-line");
    const headline = getPrimaryHeadline(recommendation, listing);
    const detailLines = getDetailLines(recommendation, listing, headline);

    if (recommendation.priorityRank === 1) {
      card.classList.add("priority-top");
      const topCardReason = buildTopCardReason(recommendation, listing, detailLines);
      if (topCardReason) {
        topRationale.classList.remove("hidden");
        topRationaleText.textContent = topCardReason;
      } else {
        topRationale.classList.add("hidden");
        topRationaleText.textContent = "";
      }
      analysisSummary.classList.add("hidden");
      analysisSummary.textContent = "";
      issueElement.classList.add("hidden");
      whyElement.classList.add("hidden");
    } else {
      topRationale.classList.add("hidden");
      topRationaleText.textContent = "";
      setOptionalText(issueElement, detailLines.problem);
      setOptionalText(whyElement, detailLines.why, detailLines.problem);
    }

    fragment.querySelector(".category").textContent = recommendation.categoryLabel;
    fragment.querySelector(".title").textContent = headline;
    fragment.querySelector(".score-chip").textContent = `Priority ${recommendation.priorityRank}`;
    impactLine.textContent = buildRevenueImpactLine(recommendation);
    fragment.querySelector(".current-image").src = recommendationPhotos.before?.url || "";
    fragment.querySelector(".edit-changes").innerHTML = buildEditChangesMarkup(recommendation);
    beforeCaption.textContent = recommendationPhotos.beforeLabel;
    previewCaption.textContent = recommendationPhotos.previewLabel;

    hydrateDecision(decisionKey, decisionStatus);
    renderAutoPreview(listing, recommendation, recommendationPhotos.preview, variantImage, placeholder, acceptButton, declineButton, decisionStatus);

    acceptButton.addEventListener("click", async () => {
      await chrome.storage.local.set({
        [decisionKey]: {
          decision: "accepted",
          decidedAt: new Date().toISOString()
        }
      });
      decisionStatus.textContent = "Marked to use when you update the listing.";
    });

    declineButton.addEventListener("click", async () => {
      await chrome.storage.local.set({
        [decisionKey]: {
          decision: "declined",
          decidedAt: new Date().toISOString()
        }
      });
      decisionStatus.textContent = "Dismissed for now.";
    });

    elements.recommendations.appendChild(card);
  }
}

function renderAutoPreview(listing, recommendation, photo, variantImage, placeholder, acceptButton, declineButton, decisionStatus) {
  acceptButton.disabled = false;
  declineButton.disabled = false;

  if (recommendation.category === "sequence" || recommendation.editPlan?.mode === "sequence_only") {
    variantImage.classList.add("hidden");
    placeholder.classList.remove("hidden");
    placeholder.innerHTML = buildSequencePreviewMarkup(listing, recommendation);
    decisionStatus.textContent = "";
    return;
  }

  try {
    variantImage.src = photo?.url || "";
    applyVariantPreview(variantImage, recommendation.editPlan);
    variantImage.classList.remove("hidden");
    placeholder.classList.add("hidden");
    decisionStatus.textContent = "";
  } catch (error) {
    acceptButton.disabled = true;
    declineButton.disabled = true;
    variantImage.classList.add("hidden");
    placeholder.classList.remove("hidden");
    placeholder.innerHTML = "";
    placeholder.textContent = "Preview unavailable.";
    decisionStatus.textContent = error.message || "Variant preview failed.";
  }
}

async function hydrateDecision(decisionKey, element) {
  const stored = await chrome.storage.local.get([decisionKey]);
  const decision = stored[decisionKey];
  if (!decision) {
    return;
  }

  element.textContent = `Previously marked ${decision.decision} on ${new Date(decision.decidedAt).toLocaleString()}.`;
}

function buildDecisionKey(listing, recommendation) {
  return `airVisual:${listing.listingUrl}:${recommendation.id}`;
}

async function callApi(path, payload, timeoutMs = ANALYSIS_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${state.backendUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw toUserFacingRequestError(error, path, timeoutMs);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  return data;
}

async function sendMessageWithTimeout(tabId, message, timeoutMs) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("The Airbnb page did not respond. Reload the page and try again."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, message), timeoutPromise]);
  } catch (error) {
    if (isMissingReceiverError(error)) {
      await ensureContentScript(tabId);
      return Promise.race([chrome.tabs.sendMessage(tabId, message), timeoutPromise]);
    }
    throw error;
  }
}

async function refreshRuntimeStatus() {
  try {
    const status = await callGet("/api/status");
    state.runtimeStatus = status;
    return status;
  } catch (error) {
    const fallback = {
      ready: false,
      mode: "unknown",
      message: error.message || "Could not reach the backend.",
      nextSteps: [
        "Start the Air Visual server with npm run dev.",
        "Make sure Ollama is running."
      ]
    };
    state.runtimeStatus = fallback;
    return fallback;
  }
}

async function callGet(path, timeoutMs = STATUS_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${state.backendUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw toUserFacingRequestError(error, path, timeoutMs);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

function applyVariantPreview(element, editPlan = {}) {
  const brightness = normaliseNumber(editPlan.brightness, 1);
  const contrast = normaliseNumber(editPlan.contrast, 1);
  const saturation = normaliseNumber(editPlan.saturation, 1);
  const zoom = normaliseNumber(editPlan.zoom, 1);
  const focusX = normaliseNumber(editPlan.focusX, 50);
  const focusY = normaliseNumber(editPlan.focusY, 50);

  element.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
  element.style.transform = `scale(${zoom})`;
  element.style.transformOrigin = `${focusX}% ${focusY}%`;
  element.style.objectPosition = `${focusX}% ${focusY}%`;
}

function setStatus(message, tone = "info") {
  if (!message) {
    clearStatus();
    return;
  }

  elements.status.className = `status ${tone}`;
  elements.status.textContent = message;
  elements.status.classList.remove("hidden");
}

function clearStatus() {
  elements.status.textContent = "";
  elements.status.className = "status hidden";
}

function formatCurrency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Not detected";
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function buildRevenueImpactLine(recommendation) {
  const min = normaliseNumber(recommendation.projectedMonthlyRevenueLiftMin, 0);
  const max = normaliseNumber(recommendation.projectedMonthlyRevenueLiftMax, 0);

  if (max <= 0) {
    return "Estimated upside is modest but worth testing.";
  }

  if (Math.abs(max - min) <= 3) {
    return `Estimated revenue increase: about ${formatCurrency(max)}/mo`;
  }

  return `Estimated revenue increase: ${formatCurrency(min)}-${formatCurrency(max)}/mo`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normaliseNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildEditChangesMarkup(recommendation) {
  const editPlan = recommendation.editPlan || {};
  const changes = [];

  if (recommendation.category === "cover_photo" && typeof recommendation.coverPhotoTargetIndex === "number") {
    changes.push(
      recommendation.coverPhotoTargetIndex > 0
        ? `New hero: photo ${recommendation.coverPhotoTargetIndex + 1}`
        : "Current hero stays"
    );
  }

  if (recommendation.category === "sequence" || editPlan.mode === "sequence_only") {
    changes.push(buildSequenceMoveText(recommendation));
  } else {
    if (Math.abs((editPlan.brightness ?? 1) - 1) >= 0.02) {
      changes.push(`Brightness ${formatSignedPercent(editPlan.brightness - 1)}`);
    }
    if (Math.abs((editPlan.contrast ?? 1) - 1) >= 0.02) {
      changes.push(`Contrast ${formatSignedPercent(editPlan.contrast - 1)}`);
    }
    if (Math.abs((editPlan.saturation ?? 1) - 1) >= 0.02) {
      changes.push(`Saturation ${formatSignedPercent(editPlan.saturation - 1)}`);
    }
    if ((editPlan.zoom ?? 1) > 1.01) {
      changes.push(`Crop tighter ${formatSignedPercent(editPlan.zoom - 1)}`);
    }
    if (Math.abs((editPlan.focusX ?? 50) - 50) >= 4 || Math.abs((editPlan.focusY ?? 50) - 50) >= 4) {
      changes.push(`Shift focus to ${Math.round(editPlan.focusX ?? 50)}% / ${Math.round(editPlan.focusY ?? 50)}%`);
    }
  }

  if (!changes.length) {
    changes.push("No visible pixel changes");
  }

  return changes.map((change) => `<span class="edit-chip">${escapeHtml(change)}</span>`).join("");
}

function formatSignedPercent(value) {
  const signedPercent = Math.round(value * 100);
  return `${signedPercent > 0 ? "+" : ""}${signedPercent}%`;
}

function getPrimaryHeadline(recommendation, listing) {
  const candidates = [recommendation.action, recommendation.title]
    .map((value) => cleanText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!isLowValueText(candidate, listing)) {
      return candidate;
    }
  }

  return getFallbackHeadline(recommendation);
}

function getFallbackHeadline(recommendation) {
  switch (recommendation.category) {
    case "cover_photo":
      return recommendation.coverPhotoTargetIndex > 0
        ? `Replace the current hero image with photo ${recommendation.coverPhotoTargetIndex + 1}.`
        : "Tighten and brighten the current hero image.";
    case "sequence":
      return buildSequenceMoveText(recommendation);
    case "brightness":
      return "Brighten this image.";
    case "crop":
      return "Tighten the crop.";
    case "composition":
      return "Reframe the composition.";
    case "amenity_visibility":
      return "Make the key amenity clearer.";
    default:
      return "Improve this photo.";
  }
}

function getDetailLines(recommendation, listing, headline) {
  const problem = getDistinctUsefulText(recommendation.problem, listing, [headline]);
  const why = getDistinctUsefulText(recommendation.whyItMatters, listing, [headline, problem]);
  return { problem, why };
}

function buildTopCardReason(recommendation, listing, detailLines) {
  const categoryMatchedReason = [detailLines.problem, detailLines.why]
    .map((value) => cleanText(value))
    .find((value) => value && doesReasonMatchCategory(value, recommendation.category, listing));

  if (categoryMatchedReason) {
    return categoryMatchedReason;
  }

  return getTopCardReasonFallback(recommendation);
}

function doesReasonMatchCategory(text, category, listing) {
  const normalised = normaliseText(text);
  if (!normalised) {
    return false;
  }

  if (normalised === normaliseText(listing?.title || "")) {
    return false;
  }

  switch (category) {
    case "brightness":
      return /\b(light|lighting|dark|dim|bright|brightness|exposure|shadow)\b/.test(normalised);
    case "crop":
      return /\b(crop|cropping|tight|wide|closer|frame|framing|focus|focal)\b/.test(normalised);
    case "composition":
      return /\b(composition|reframe|reframing|frame|framing|focus|focal|eye|read|clutter|subject)\b/.test(normalised);
    case "amenity_visibility":
      return /\b(amenity|feature|workspace|balcony|view|pool|kitchen|patio|tub|hot tub|washer|dryer)\b/.test(normalised);
    case "cover_photo":
      return /\b(hero|cover|first|click|thumbnail|lead)\b/.test(normalised);
    case "sequence":
      return /\b(sequence|order|earlier|later|first|before|after)\b/.test(normalised);
    default:
      return true;
  }
}

function getTopCardReasonFallback(recommendation) {
  switch (recommendation.category) {
    case "brightness":
      return "The photo reads too dark or flat to sell the room quickly.";
    case "crop":
      return "The frame is too loose, so the main feature lands too slowly.";
    case "composition":
      return "The eye does not land on the strongest feature fast enough.";
    case "amenity_visibility":
      return "A bookable feature is present, but it is not reading clearly enough.";
    case "cover_photo":
      return "The current lead image is not doing the most persuasive selling work.";
    case "sequence":
      return "A stronger image should appear earlier so the listing reads faster.";
    default:
      return "This is the clearest quick visual fix in the current set.";
  }
}

function setOptionalText(element, text, duplicateAgainst = "") {
  const value = cleanText(text);
  if (!value || normaliseText(value) === normaliseText(duplicateAgainst)) {
    element.classList.add("hidden");
    element.textContent = "";
    return;
  }

  element.classList.remove("hidden");
  element.textContent = value;
}

function getDistinctUsefulText(value, listing, comparisons = []) {
  const text = cleanText(value);
  if (!text || isLowValueText(text, listing, comparisons)) {
    return "";
  }
  return text;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normaliseText(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLowValueText(value, listing, comparisons = []) {
  const normalised = normaliseText(value);
  if (!normalised) {
    return true;
  }

  if (/^(?:n a|na|n\/a|not available|unknown|none found|not detected)$/.test(normalised)) {
    return true;
  }

  if (["cover photo", "composition", "sequence", "brightness", "crop", "amenity visibility"].includes(normalised)) {
    return true;
  }

  if (/_/.test(String(value || ""))) {
    return true;
  }

  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalised)) {
    return true;
  }

  if (normalised === normaliseText(listing?.title || "")) {
    return true;
  }

  if (normalised.split(" ").length === 1 && normalised.length <= 8) {
    return true;
  }

  return comparisons.some((item) => normalised === normaliseText(item || ""));
}

function getRecommendationPhotos(listing, recommendation) {
  const fallbackPhoto = listing.photos[0];
  const targetPhoto = listing.photos.find((item) => item.index === recommendation.photoIndex) || fallbackPhoto;

  if (recommendation.category === "cover_photo" && typeof recommendation.coverPhotoTargetIndex === "number") {
    const currentCoverPhoto = fallbackPhoto;
    const newCoverPhoto =
      listing.photos.find((item) => item.index === recommendation.coverPhotoTargetIndex) || targetPhoto || fallbackPhoto;
    return {
      before: currentCoverPhoto,
      preview: newCoverPhoto,
      beforeLabel: formatPhotoLabel("Current hero", currentCoverPhoto?.index),
      previewLabel: newCoverPhoto?.index === currentCoverPhoto?.index
        ? formatPhotoLabel("Edited hero", newCoverPhoto?.index)
        : formatPhotoLabel("New hero", newCoverPhoto?.index)
    };
  }

  return {
    before: targetPhoto,
    preview: targetPhoto,
    beforeLabel: recommendation.category === "sequence"
      ? formatPhotoLabel("Current slot", targetPhoto?.index)
      : formatPhotoLabel("Source photo", targetPhoto?.index),
    previewLabel: recommendation.category === "sequence"
      ? formatSequenceTargetLabel(recommendation)
      : "Preview"
  };
}

function formatPhotoLabel(label, index) {
  if (typeof index !== "number") {
    return label;
  }
  return `${label} · photo ${index + 1}`;
}

function buildSequenceMoveText(recommendation) {
  const currentSlot = typeof recommendation.photoIndex === "number" ? recommendation.photoIndex + 1 : null;
  const targetSlot = typeof recommendation.sequenceTargetIndex === "number" ? recommendation.sequenceTargetIndex + 1 : null;

  if (currentSlot && targetSlot) {
    return `Move photo ${currentSlot} to slot ${targetSlot}`;
  }

  return "Reorder earlier in the sequence";
}

function formatSequenceTargetLabel(recommendation) {
  const targetSlot = typeof recommendation.sequenceTargetIndex === "number" ? recommendation.sequenceTargetIndex + 1 : null;
  return targetSlot ? `Recommended slot ${targetSlot}` : "Recommended order";
}

function buildSequencePreviewMarkup(listing, recommendation) {
  const currentSlot = typeof recommendation.photoIndex === "number" ? recommendation.photoIndex + 1 : 1;
  const targetSlot = typeof recommendation.sequenceTargetIndex === "number" ? recommendation.sequenceTargetIndex + 1 : 1;
  const slotCount = getSequenceSlotCount(listing, currentSlot, targetSlot);
  const currentOrder = Array.from({ length: slotCount }, (_, index) => index + 1);
  const nextOrder = currentOrder.slice();
  const fromIndex = nextOrder.indexOf(currentSlot);

  if (fromIndex >= 0) {
    nextOrder.splice(fromIndex, 1);
    nextOrder.splice(Math.max(0, targetSlot - 1), 0, currentSlot);
  }

  return `
    <div class="sequence-preview">
      ${renderSequenceRow("Current order", currentOrder, currentSlot, null)}
      ${renderSequenceRow("Recommended order", nextOrder, currentSlot, targetSlot)}
    </div>
  `;
}

function renderSequenceRow(label, order, movedSlot, targetSlot) {
  return `
    <div class="sequence-row">
      <div class="sequence-label">${escapeHtml(label)}</div>
      <div class="sequence-slots">
        ${order.map((slot, index) => {
          const classes = ["sequence-chip"];
          if (slot === movedSlot) {
            classes.push("moved");
          }
          if (targetSlot && index + 1 === targetSlot) {
            classes.push("target");
          }
          return `<span class="${classes.join(" ")}">${slot}</span>`;
        }).join("")}
      </div>
    </div>
  `;
}

function getSequenceSlotCount(listing, currentSlot, targetSlot) {
  return Math.min(
    Math.max(listing?.photos?.length || 0, currentSlot, targetSlot, 4),
    8
  );
}

function isMissingReceiverError(error) {
  return /Receiving end does not exist/i.test(error?.message || "");
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || /signal timed out|aborted due to timeout/i.test(error?.message || "");
}

function toUserFacingRequestError(error, path, timeoutMs) {
  if (isTimeoutError(error)) {
    const seconds = Math.round(timeoutMs / 1000);
    if (path === "/api/status") {
      return new Error(`Backend check timed out after ${seconds}s. Make sure npm run dev is running and Ollama is reachable.`);
    }

    if (path === "/api/analyze") {
      return new Error(
        `Analysis timed out after ${seconds}s. Ollama may still be warming up or running slowly on image input. Retry, or enable demo mode with USE_MOCK_AI=1.`
      );
    }
  }

  return error instanceof Error ? error : new Error("Request failed.");
}

async function ensureContentScript(tabId) {
  const scriptFile = chrome.runtime.getManifest()?.content_scripts?.[0]?.js?.[0];
  if (!scriptFile) {
    throw new Error("The extension manifest is missing the content script entry.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [scriptFile]
  });
}
