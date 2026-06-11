# Air Visual Privacy Policy

Last updated: 2026-03-18

Air Visual is a Chrome extension for Airbnb hosts. This policy explains what data the extension handles, where that data goes, and how to map that behavior into Chrome Web Store privacy disclosures.

## Extension Permissions

Air Visual currently declares these Chrome extension permissions:

- `activeTab`
- `sidePanel`
- `scripting`
- `storage`
- `tabs`

Air Visual currently declares these host permissions:

- `https://www.airbnb.com/*`
- `https://*.airbnb.com/*`
- `http://127.0.0.1/*`

These permissions are used only to open the side panel, identify the active Airbnb tab, read the current Airbnb page, inject or re-inject the content script when needed, save local recommendation decisions, and call the local analysis backend.

## Data Categories Air Visual Handles

When you open Air Visual on an Airbnb page, the extension may access or store:

- webpage content from the active Airbnb page, including the current page URL, listing title, visible page text, nightly-rate text, occupancy hints, amenity terms, image URLs, image alt text, and basic image metadata such as dimensions
- user activity within the extension, specifically your accept or decline decisions for recommendations
- local extension storage data, specifically saved recommendation decisions in `chrome.storage.local`

Air Visual does not request or intentionally collect:

- precise location
- contacts
- health information
- financial account or payment card data
- authentication credentials
- personal communications
- web browsing history outside the current Airbnb page being analyzed

## How Air Visual Uses Data

Air Visual uses the accessed data only to:

- identify the current Airbnb listing
- extract visible listing context from the active page
- generate photo-quality recommendations
- render deterministic preview suggestions inside the extension UI
- remember whether you accepted or declined a recommendation on your device

Air Visual is not designed to:

- sell personal information
- serve ads
- build advertising profiles
- make credit, lending, employment, housing, insurance, or similar eligibility decisions

## Where Data Goes

Air Visual supports two analysis modes.

### Local Mode

In local mode, selected listing context and image references are sent from the extension to a local backend running on your machine, typically at `http://127.0.0.1:8787`. That backend may then call a local Ollama instance running on the same machine.

In this mode, the extension does not send listing data to Air Visual's own remote servers because Air Visual does not operate a separate hosted database or application server in this repo.

### Hosted Gemini Mode

If you configure Gemini mode, selected listing context and image data are sent to the Google Gemini Developer API so the model can analyze listing photos and return recommendations.

Gemini mode is optional and depends on user configuration. It is not required for the extension to function in local mode.

## Third-Party Services

Depending on configuration, Air Visual may send data to:

- Airbnb-controlled pages and image hosts, when the extension reads the active page and when the local backend fetches listing images from Airbnb or related CDN URLs
- Google Gemini Developer API, but only if you explicitly configure Gemini mode

Air Visual does not include:

- ad networks
- analytics SDKs
- social media trackers
- data broker integrations

## Data Storage And Retention

Air Visual stores recommendation decisions locally in Chrome extension storage on your device. Those decisions may remain there until you clear extension storage, remove the extension, or otherwise delete your local browser data.

Air Visual does not include its own external database in this repo.

The extension does not intentionally persist the full extracted Airbnb listing context in its own storage. Listing context is processed in memory for the current analysis flow and sent to the configured analysis backend as described above.

## Chrome Web Store Disclosure Summary

For Chrome Web Store disclosure purposes, Air Visual's behavior can be summarized as follows:

- website content is accessed: yes
- webpage content is transmitted for analysis: yes
- user activity within the extension is stored: yes, accept or decline decisions only
- data is stored on the device: yes
- data is sold to third parties: no
- data is used for advertising or marketing: no
- data is used for creditworthiness or other eligibility determinations: no
- data is sent to a third-party remote service by default: no
- data may be sent to a third-party remote service when Gemini mode is enabled: yes

`activeTab` is a Chrome permission, not a standalone data category. In practice, the main reportable CWS data categories for this extension are webpage content from Airbnb pages and user activity within the extension.

## User Controls

You control whether to run the extension on an Airbnb page and whether to configure a hosted model provider such as Gemini.

You can clear locally stored recommendation decisions by clearing Chrome extension storage for Air Visual or uninstalling the extension.

## Data Sale Or Advertising

Air Visual does not sell personal information and is not designed for advertising, retargeting, credit scoring, or data brokering.

## Changes To This Policy

If Air Visual changes its permissions, supported providers, or data flows, this policy should be updated before publication or release.

## Contact

Before publishing, replace this section with a real support contact or website URL for the Chrome Web Store listing.
