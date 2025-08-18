#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

# Create a 1024x1024 icon (macOS prefers this size for source)
size = 1024

# Anthropic/Claude orange color
CLAUDE_ORANGE = (235, 140, 85, 255)  # #EB8C55
WHITE = (255, 255, 255, 255)

# Create image with orange filling the entire space
img = Image.new('RGBA', (size, size), CLAUDE_ORANGE)
draw = ImageDraw.Draw(img)

# Try to load a bold monospace font
try:
    font_paths = [
        "/System/Library/Fonts/Monaco.dfont",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Courier.dfont",
    ]
    font = None
    for font_path in font_paths:
        if os.path.exists(font_path):
            try:
                # Large font for visibility
                font = ImageFont.truetype(font_path, 400)
                break
            except:
                continue
    if not font:
        font = ImageFont.load_default()
except:
    font = ImageFont.load_default()

# Draw a large >_ in the center
center_x = size // 2
center_y = size // 2

# Draw > in white
draw.text((center_x - 200, center_y - 40), ">", fill=WHITE, font=font, anchor="mm")

# Draw _ (underscore) in white
draw.text((center_x + 80, center_y + 40), "_", fill=WHITE, font=font, anchor="mm")

# Make the underscore bolder
for offset in range(1, 8):
    draw.text((center_x + 80 + offset, center_y + 40), "_", fill=WHITE, font=font, anchor="mm")

# Save the main icon
os.makedirs('assets', exist_ok=True)
img.save('assets/icon_1024.png')
print("Created: assets/icon_1024.png")

# Create all required sizes
sizes = [512, 256, 128, 64, 32, 16]
for size_variant in sizes:
    resized = img.resize((size_variant, size_variant), Image.Resampling.LANCZOS)
    resized.save(f'assets/icon_{size_variant}.png')
    print(f"Created: assets/icon_{size_variant}.png")

# Save as main icon.png
img_512 = img.resize((512, 512), Image.Resampling.LANCZOS)
img_512.save('assets/icon.png')
print("Created: assets/icon.png")

print("\nIcon features:")
print("- FULL orange background - no dark container")
print("- Large white >_ symbol")
print("- Fills entire icon space like Slack/Discord")
print("- High contrast for dock visibility")