#!/usr/bin/env python3
"""Generate kiwimu logo samples using Gemini 2.5 Flash Image Generation."""

import base64
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

VAULT_ITEM = "Gemini API Keys"
KEY_FIELDS = [
    "key_99_maytryark_purcahsed",  # paid key (free keys have 0 quota for image gen)
    "key_1_maytryark",
    "key_2_imsi.agent.dev",
    "key_3_open330.dev",
    "key_4_jiunbae.623",
    "key_5_jiunbae.dev",
]
MODEL = "gemini-2.5-flash-image"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
OUTPUT_DIR = Path(__file__).parent / "assets" / "logos"


def get_api_keys() -> list[str]:
    """Get all Gemini API keys from Bitwarden vault."""
    session = Path.home() / ".bw_session"
    bw_session = session.read_text().strip()
    result = subprocess.run(
        ["bw", "get", "item", VAULT_ITEM],
        capture_output=True, text=True,
        env={**__import__("os").environ, "BW_SESSION": bw_session},
    )
    item = json.loads(result.stdout)
    fields = {f["name"]: f["value"] for f in item.get("fields", [])}
    keys = [fields[k] for k in KEY_FIELDS if k in fields]
    if not keys:
        raise RuntimeError("No Gemini API keys found in vault")
    return keys


def generate_image(api_keys: list[str], prompt: str, filename: str, key_idx: int = 0) -> tuple[bool, int]:
    """Generate an image using Gemini API, rotating keys on 429. Returns (success, next_key_idx)."""
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": "1:1",
                "imageSize": "1K",
            },
        },
    }).encode()

    # Try each key starting from key_idx
    data = None
    tried = 0
    idx = key_idx
    while tried < len(api_keys):
        api_key = api_keys[idx]
        req = urllib.request.Request(
            f"{API_URL}?key={api_key}",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f"  Key {idx + 1} rate limited, trying next...")
                idx = (idx + 1) % len(api_keys)
                tried += 1
                continue
            print(f"  ERROR: {e}")
            return False, idx
        except Exception as e:
            print(f"  ERROR: {e}")
            return False, idx

    if data is None:
        print(f"  ERROR: All {len(api_keys)} keys rate limited")
        return False, idx

    # Extract image and text from response
    candidates = data.get("candidates", [])
    if not candidates:
        print(f"  ERROR: No candidates in response")
        return False, idx

    parts = candidates[0].get("content", {}).get("parts", [])
    for part in parts:
        if "inlineData" in part:
            img_data = base64.b64decode(part["inlineData"]["data"])
            mime = part["inlineData"].get("mimeType", "image/png")
            ext = "png" if "png" in mime else "jpg"
            filepath = OUTPUT_DIR / f"{filename}.{ext}"
            filepath.write_bytes(img_data)
            print(f"  Saved: {filepath} ({len(img_data) // 1024}KB)")
            return True, idx
        elif "text" in part:
            print(f"  Model says: {part['text'][:200]}")

    print(f"  ERROR: No image in response")
    return False, idx


PROMPTS = [
    {
        "name": "logo_1_cute_mascot",
        "prompt": (
            "Design a cute, friendly mascot logo for 'kiwimu' (키위무). "
            "The mascot is a creative hybrid of a kiwi fruit and a Korean radish (무). "
            "The body shape is a round kiwi fruit (brown fuzzy exterior) with a small green sprout on top like a radish leaf. "
            "The cross-section reveals bright green kiwi interior with black seeds. "
            "Kawaii style with small happy eyes and a gentle smile. "
            "Clean white background, flat design, suitable for a wiki-style knowledge platform logo. "
            "No text in the image."
        ),
    },
    {
        "name": "logo_2_minimalist_icon",
        "prompt": (
            "Design a minimalist, modern app icon for 'kiwimu'. "
            "A sleek geometric combination of a kiwi fruit slice (showing the distinctive green interior with seed pattern) "
            "merged with the silhouette of a white Korean radish (무/daikon). "
            "The radish shape contains the kiwi cross-section pattern inside. "
            "Use a fresh green (#7CB342) and white color palette. "
            "Flat vector style, clean lines, no text. White background. "
            "Think of it as a modern tech company logo."
        ),
    },
    {
        "name": "logo_3_playful_fusion",
        "prompt": (
            "Create a playful, colorful logo icon showing a whimsical fusion vegetable-fruit: "
            "a Korean radish (무/daikon) that has kiwi fruit characteristics. "
            "The white radish body has brown kiwi-like fuzzy patches, and when cut open "
            "it reveals a bright green kiwi interior with black seeds instead of white radish flesh. "
            "Green leafy top sprouting from the radish. Cartoon illustration style. "
            "Vibrant colors on a clean white background. No text. "
            "This is for a fun knowledge wiki platform called kiwimu."
        ),
    },
    {
        "name": "logo_4_split_design",
        "prompt": (
            "Design a creative split logo icon: the left half shows a kiwi fruit cross-section "
            "(bright green with black seeds pattern) and the right half shows a Korean white radish (무/daikon) cross-section. "
            "The two halves merge seamlessly in the center creating one unified circular icon. "
            "Clean, modern vector style. Color palette: kiwi green, white, with subtle brown accents. "
            "No text. White background. Suitable as a favicon or app icon for a wiki knowledge base called kiwimu."
        ),
    },
    {
        "name": "logo_5_stamp_style",
        "prompt": (
            "Design a vintage stamp/seal style circular logo for 'kiwimu' wiki platform. "
            "Inside the circle: a cute illustration of a kiwi bird holding a Korean radish (무/daikon) "
            "with one wing, while the radish has kiwi fruit texture and green interior visible. "
            "The border of the circle has a decorative pattern. "
            "Monochrome green ink style like a traditional stamp. Clean white background. "
            "No text. Retro but charming aesthetic."
        ),
    },
]


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Fetching Gemini API keys from vault...")
    api_keys = get_api_keys()
    print(f"Loaded {len(api_keys)} API keys\n")

    print(f"Model: {MODEL}")
    print(f"Output: {OUTPUT_DIR}\n")

    success = 0
    key_idx = 0
    for i, item in enumerate(PROMPTS, 1):
        print(f"[{i}/5] Generating: {item['name']}")
        ok, key_idx = generate_image(api_keys, item["prompt"], item["name"], key_idx)
        if ok:
            success += 1
            # Rotate to next key for next request to spread load
            key_idx = (key_idx + 1) % len(api_keys)
        print()

    print(f"Done! {success}/5 logos generated in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
