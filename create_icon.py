#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

# Create a 512x512 icon
size = 512
img = Image.new('RGBA', (size, size), (26, 26, 26, 255))  # Dark background
draw = ImageDraw.Draw(img)

# Draw rounded rectangle background
def rounded_rectangle(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([(x0, y0 + radius), (x1, y1 - radius)], fill=fill)
    draw.rectangle([(x0 + radius, y0), (x1 - radius, y1)], fill=fill)
    draw.pieslice([(x0, y0), (x0 + 2 * radius, y0 + 2 * radius)], 180, 270, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y0), (x1, y0 + 2 * radius)], 270, 360, fill=fill)
    draw.pieslice([(x0, y1 - 2 * radius), (x0 + 2 * radius, y1)], 90, 180, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y1 - 2 * radius), (x1, y1)], 0, 90, fill=fill)

# Draw terminal window
terminal_color = (42, 42, 42, 255)
rounded_rectangle(draw, (80, 140, 432, 372), 8, terminal_color)

# Draw terminal header
header_color = (51, 51, 51, 255)
draw.rectangle([(80, 140), (432, 172)], fill=header_color)

# Draw window controls
draw.ellipse([(98, 150), (110, 162)], fill=(255, 95, 86, 255))  # Red
draw.ellipse([(118, 150), (130, 162)], fill=(255, 189, 46, 255))  # Yellow
draw.ellipse([(138, 150), (150, 162)], fill=(39, 201, 63, 255))  # Green

# Draw "Claude >" text effect
try:
    # Try to use a monospace font if available
    font = ImageFont.truetype("/System/Library/Fonts/Monaco.dfont", 28)
except:
    font = ImageFont.load_default()

# Draw text with a blue color
text_color = (74, 158, 255, 255)
draw.text((100, 200), "claude", fill=text_color, font=font)
draw.text((180, 200), ">", fill=(224, 224, 224, 255), font=font)

# Draw cursor
draw.rectangle([(200, 195), (216, 215)], fill=(74, 158, 255, 200))

# Draw grid dots for projects
for i in range(3):
    for j in range(3):
        x = 120 + i * 20
        y = 280 + j * 20
        color = (74, 158, 255, 255) if i == 0 and j == 0 else (102, 102, 102, 255)
        draw.ellipse([(x-4, y-4), (x+4, y+4)], fill=color)

# Draw "Dashboard" text
try:
    title_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 42)
except:
    title_font = font

draw.text((256, 280), "Dashboard", fill=(224, 224, 224, 255), font=title_font, anchor="mm")

# Save as PNG
img.save('assets/icon.png')
print("Icon created: assets/icon.png")

# Create smaller versions
for size in [256, 128, 64, 32, 16]:
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(f'assets/icon_{size}.png')
    print(f"Created: assets/icon_{size}.png")