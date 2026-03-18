#!/usr/bin/env python3

import argparse
import base64
import json
import os
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Tuple

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
ASSET_DIR = ROOT / "store-assets"
ICON_DIR = ROOT / "icons"
MASTER_DIR = ROOT / "tmp" / "generated-cws-masters"

DEFAULT_GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image"

REFERENCE_BRAND_DESCRIPTION = textwrap.dedent(
    """
    Use the provided reference logo as the visual source of truth. Preserve the brand cues:
    a camera lens, a house or framed listing photo, two upward green arrows, a red roof accent,
    and a blue / green hospitality palette. Redesign it with cleaner geometry, better spacing,
    and premium Chrome Web Store quality. Do not invent a different brand.
    """
).strip()

COMMON_IMAGE_RULES = textwrap.dedent(
    """
    Output polished marketing artwork with crisp vector-style edges, modern SaaS presentation,
    balanced negative space, accurate typography, and no watermark. Avoid gibberish text,
    warped UI, clutter, extra icons, or stock-photo realism.
    """
).strip()

ASSETS = [
    {
        "name": "icon",
        "master_name": "icon-master.png",
        "output_size": (1024, 1024),
        "targets": [
            ("icons/icon-128.png", (128, 128)),
            ("icons/icon-48.png", (48, 48)),
            ("icons/icon-32.png", (32, 32)),
            ("icons/icon-16.png", (16, 16)),
        ],
        "prompt": textwrap.dedent(
            """
            Create a premium app icon for the Chrome extension "Air Visual".
            No text. Centered composition. Very readable at tiny sizes.
            Use a dark blue rounded-square background and a simplified mark that combines:
            a clean house roof or framed listing photo, a camera lens, and two upward green arrows.
            Include a small red roof accent. Keep the composition bold, flat, and modern.
            """
        ).strip(),
    },
    {
        "name": "small_promo",
        "master_name": "air-visual-small-promo-master.png",
        "output_size": (1320, 840),
        "targets": [
            ("store-assets/promo/air-visual-small-promo-440x280.png", (440, 280)),
        ],
        "prompt": textwrap.dedent(
            """
            Create a Chrome Web Store small promo image for Air Visual.
            Horizontal composition. Left side: strong brand lockup and concise marketing message.
            Right side: a clean product card or side-panel mockup. Keep the layout spacious.
            Include only this exact text:
            Air Visual
            For Airbnb hosts
            Truthful photo wins for cover choice, crop, light, and sequence.
            Fast side-panel reviews for Airbnb listing photos.
            """
        ).strip(),
    },
    {
        "name": "marquee_promo",
        "master_name": "air-visual-marquee-promo-master.png",
        "output_size": (2000, 800),
        "targets": [
            ("store-assets/promo/air-visual-marquee-promo-1400x560.png", (1400, 560)),
        ],
        "prompt": textwrap.dedent(
            """
            Create a Chrome Web Store marquee promo image for Air Visual.
            Use a premium dark-blue gradient background. Left side: large brand treatment and headline.
            Right side: a refined side-panel product mockup with recommendation cards.
            Include only this exact text:
            Air Visual
            For Airbnb hosts
            Fast, truthful photo recommendations for cover choice, crop, light, and sequence.
            Designed for quick listing reviews, not generative edits.
            """
        ).strip(),
    },
    {
        "name": "screenshot_1",
        "master_name": "air-visual-screenshot-1-master.png",
        "output_size": (1600, 1000),
        "targets": [
            ("store-assets/screenshots/air-visual-screenshot-1-1280x800.png", (1280, 800)),
        ],
        "prompt": textwrap.dedent(
            """
            Create a polished product screenshot-style marketing image for Air Visual.
            Show an Airbnb listing page on the left and the Air Visual side panel on the right.
            Make the UI feel credible, crisp, and readable. Use the Air Visual brand colors.
            Include only this exact text:
            CHROME SIDE PANEL
            Review the current listing and surface stronger cover, crop, light, and sequencing improvements.
            Truthful photo wins, fast.
            Airbnb listing page
            Host view
            Air Visual
            Ready
            Choose brighter hero
            Crop to focal point
            Move amenity earlier
            Accept
            Skip
            """
        ).strip(),
    },
    {
        "name": "screenshot_2",
        "master_name": "air-visual-screenshot-2-master.png",
        "output_size": (1600, 1000),
        "targets": [
            ("store-assets/screenshots/air-visual-screenshot-2-1280x800.png", (1280, 800)),
        ],
        "prompt": textwrap.dedent(
            """
            Create a polished product screenshot-style marketing image for Air Visual.
            Left side: a before/after-style review card. Right side: the Air Visual side panel.
            Make the interface clean, readable, and consistent with the reference brand.
            Include only this exact text:
            ACTIONABLE OUTPUT
            Each recommendation stays close to what is already true in the photo.
            Tier 1 guidance, not fantasy edits.
            Before / after focus
            Before
            After
            Suggestion: brighten the hero image and tighten the crop.
            The room reads warmer, the balcony stays visible, and the cover feels more spacious.
            Air Visual
            Ready
            Choose brighter hero
            Crop to focal point
            Move amenity earlier
            Accept
            Skip
            """
        ).strip(),
    },
]


def load_dotenv(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        env[key] = value
    return env


def get_env(name: str, dotenv: dict, default: str = "") -> str:
    return os.environ.get(name) or dotenv.get(name, default)


def encode_inline_image(path: Path) -> dict:
    mime_type = "image/png"
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        mime_type = "image/jpeg"
    return {
        "inlineData": {
            "mimeType": mime_type,
            "data": base64.b64encode(path.read_bytes()).decode("utf-8"),
        }
    }


def call_gemini(prompt: str, reference_path: Path, dotenv: dict) -> bytes:
    api_key = get_env("GEMINI_API_KEY", dotenv)
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is missing.")

    model = get_env("GEMINI_IMAGE_MODEL", dotenv, DEFAULT_GEMINI_IMAGE_MODEL)
    api_url = get_env("GEMINI_API_URL", dotenv, DEFAULT_GEMINI_API_URL)
    url = f"{api_url}/models/{model}:generateContent"

    parts = [{"text": prompt}]
    if reference_path:
        parts.append(encode_inline_image(reference_path))

    payload = {
        "contents": [{"parts": parts}],
    }

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini image request failed ({error.code}): {body}") from error

    for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        inline_data = part.get("inlineData")
        if inline_data and inline_data.get("data"):
            return base64.b64decode(inline_data["data"])

    raise RuntimeError(f"Gemini response did not contain image data: {json.dumps(data)[:2000]}")


def build_prompt(asset_prompt: str) -> str:
    return "\n\n".join([REFERENCE_BRAND_DESCRIPTION, COMMON_IMAGE_RULES, asset_prompt])


def save_master(image_bytes: bytes, master_name: str) -> Path:
    MASTER_DIR.mkdir(parents=True, exist_ok=True)
    path = MASTER_DIR / master_name
    path.write_bytes(image_bytes)
    return path


def write_targets(master_path: Path, targets: List[Tuple[str, Tuple[int, int]]]) -> None:
    with Image.open(master_path) as source:
        source = source.convert("RGBA")
        for rel_path, size in targets:
            output_path = ROOT / rel_path
            output_path.parent.mkdir(parents=True, exist_ok=True)
            fitted = ImageOps.fit(source, size, method=Image.LANCZOS, centering=(0.5, 0.5))
            fitted.save(output_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Chrome Web Store assets from a reference image using Gemini."
    )
    parser.add_argument(
        "--reference",
        required=True,
        help="Path to the logo or reference image to guide generation.",
    )
    parser.add_argument(
        "--only",
        choices=[asset["name"] for asset in ASSETS],
        help="Generate a single named asset instead of the full set.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dotenv = load_dotenv(ENV_PATH)
    reference_path = (ROOT / args.reference).resolve() if not Path(args.reference).is_absolute() else Path(args.reference)
    if not reference_path.exists():
        raise SystemExit(f"Reference image not found: {reference_path}")

    selected_assets = [asset for asset in ASSETS if not args.only or asset["name"] == args.only]
    for asset in selected_assets:
        prompt = build_prompt(asset["prompt"])
        print(f"Generating {asset['name']}...")
        image_bytes = call_gemini(prompt, reference_path, dotenv)
        master_path = save_master(image_bytes, asset["master_name"])
        write_targets(master_path, asset["targets"])
        print(f"Saved master {master_path}")
        for target_path, _ in asset["targets"]:
            print(f"Updated {target_path}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
