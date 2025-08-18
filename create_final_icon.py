#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

# Create a 1024x1024 icon (macOS prefers this size for source)
size = 1024

# Anthropic/Claude orange color
CLAUDE_ORANGE = (235, 140, 85, 255)  # #EB8C55
WHITE = (255, 255, 255, 255)

# Create image with transparent background first
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

def rounded_rectangle(draw, xy, radius, fill):
    """Draw a rounded rectangle"""
    x0, y0, x1, y1 = xy
    draw.rectangle([(x0, y0 + radius), (x1, y1 - radius)], fill=fill)
    draw.rectangle([(x0 + radius, y0), (x1 - radius, y1)], fill=fill)
    draw.pieslice([(x0, y0), (x0 + 2 * radius, y0 + 2 * radius)], 180, 270, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y0), (x1, y0 + 2 * radius)], 270, 360, fill=fill)
    draw.pieslice([(x0, y1 - 2 * radius), (x0 + 2 * radius, y1)], 90, 180, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y1 - 2 * radius), (x1, y1)], 0, 90, fill=fill)

# Draw orange background with rounded corners (22.5% corner radius like iOS/macOS apps)
corner_radius = int(size * 0.225)  # Standard iOS/macOS corner radius
rounded_rectangle(draw, (0, 0, size, size), corner_radius, CLAUDE_ORANGE)

# Try to load a bold monospace font
try:
    font_paths = [
        "/System/Library/Fonts/Monaco.dfont",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Courier.dfont",
    ]
    font = None
    font_small = None
    for font_path in font_paths:
        if os.path.exists(font_path):
            try:
                # MUCH bigger font for the > symbol
                font = ImageFont.truetype(font_path, 600)
                # Separate font for underscore
                font_small = ImageFont.truetype(font_path, 500)
                break
            except:
                continue
    if not font:
        font = ImageFont.load_default()
        font_small = font
except:
    font = ImageFont.load_default()
    font_small = font

# Draw a large >_ in the center
center_x = size // 2
center_y = size // 2

# Draw > in white - positioned more to the left
draw.text((center_x - 250, center_y - 50), ">", fill=WHITE, font=font, anchor="mm")

# Draw _ (underscore) in white - bigger and bolder
underscore_x = center_x + 120
underscore_y = center_y + 80

# Make the underscore much thicker by drawing it multiple times
for y_offset in range(-3, 4):
    for x_offset in range(-3, 12):
        draw.text((underscore_x + x_offset, underscore_y + y_offset), "_", 
                 fill=WHITE, font=font_small, anchor="mm")

# Add subtle depth with inner highlight
for i in range(3):
    alpha = 40 - i * 13
    # Top highlight
    draw.arc([(i, i), (size - i, size - i)], 
             start=225, end=315, fill=(255, 255, 255, alpha), width=2)

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

print("\nFinal icon features:")
print("- Orange background with standard macOS rounded corners (22.5% radius)")
print("- MUCH larger > symbol (600pt font)")
print("- Bold, thick underscore cursor (500pt font)")
print("- Professional app appearance like Slack/Discord")
print("- Subtle depth with inner highlight")