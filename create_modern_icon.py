#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

# Create a 512x512 icon
size = 512

# Anthropic/Claude orange color - use this as the main background
CLAUDE_ORANGE = (235, 140, 85, 255)  # #EB8C55
WHITE = (255, 255, 255, 255)
DARK_ORANGE = (215, 120, 65, 255)  # Slightly darker for depth

# Create image with orange background
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

def rounded_rectangle(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([(x0, y0 + radius), (x1, y1 - radius)], fill=fill)
    draw.rectangle([(x0 + radius, y0), (x1 - radius, y1)], fill=fill)
    draw.pieslice([(x0, y0), (x0 + 2 * radius, y0 + 2 * radius)], 180, 270, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y0), (x1, y0 + 2 * radius)], 270, 360, fill=fill)
    draw.pieslice([(x0, y1 - 2 * radius), (x0 + 2 * radius, y1)], 90, 180, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y1 - 2 * radius), (x1, y1)], 0, 90, fill=fill)

# Main background - full orange with rounded corners (like Slack)
rounded_rectangle(draw, (0, 0, 512, 512), 90, CLAUDE_ORANGE)

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
                # Make the font MUCH bigger
                font = ImageFont.truetype(font_path, 220)
                break
            except:
                continue
    if not font:
        font = ImageFont.load_default()
except:
    font = ImageFont.load_default()

# Draw a large >_ in the center
# Position for centered layout
center_x = size // 2
center_y = size // 2

# Draw > in white
draw.text((center_x - 120, center_y - 20), ">", fill=WHITE, font=font, anchor="mm")

# Draw _ (underscore) in white, slightly offset to the right
draw.text((center_x + 40, center_y + 20), "_", fill=WHITE, font=font, anchor="mm")

# Make the underscore thicker by drawing multiple times
for offset in range(1, 5):
    draw.text((center_x + 40 + offset, center_y + 20), "_", fill=WHITE, font=font, anchor="mm")

# Add a subtle inner shadow effect at the top
for i in range(3):
    alpha = 30 - i * 10
    draw.line([(90, i), (512 - 90, i)], fill=(200, 100, 50, alpha), width=1)

# Save as PNG
os.makedirs('assets', exist_ok=True)
img.save('assets/icon.png')
print("Icon created: assets/icon.png")

# Create smaller versions
for size_variant in [256, 128, 64, 32, 16]:
    resized = img.resize((size_variant, size_variant), Image.Resampling.LANCZOS)
    resized.save(f'assets/icon_{size_variant}.png')
    print(f"Created: assets/icon_{size_variant}.png")

print("\nNew icon features:")
print("- Full orange background (Anthropic brand color)")
print("- Large >_ symbol in white")
print("- Rounded corners like modern apps (Slack, Discord)")
print("- No dark border or container")
print("- Maximum visibility and recognition")