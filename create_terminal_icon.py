#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

# Create a 512x512 icon
size = 512
# Use the same background color as the app (#1a1a1a)
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))  # Transparent background
draw = ImageDraw.Draw(img)

# Anthropic/Claude orange color
CLAUDE_ORANGE = (235, 140, 85, 255)  # #EB8C55
LIGHT_GRAY = (224, 224, 224, 255)  # #e0e0e0
DARK_BG = (26, 26, 26, 255)  # #1a1a1a
TERMINAL_BG = (42, 42, 42, 255)  # #2a2a2a

def rounded_rectangle(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([(x0, y0 + radius), (x1, y1 - radius)], fill=fill)
    draw.rectangle([(x0 + radius, y0), (x1 - radius, y1)], fill=fill)
    draw.pieslice([(x0, y0), (x0 + 2 * radius, y0 + 2 * radius)], 180, 270, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y0), (x1, y0 + 2 * radius)], 270, 360, fill=fill)
    draw.pieslice([(x0, y1 - 2 * radius), (x0 + 2 * radius, y1)], 90, 180, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y1 - 2 * radius), (x1, y1)], 0, 90, fill=fill)

# Main background with app color
rounded_rectangle(draw, (32, 32, 480, 480), 48, DARK_BG)

# Create central terminal window
terminal_width = 380
terminal_height = 260
terminal_x = (size - terminal_width) // 2
terminal_y = (size - terminal_height) // 2 - 20

# Terminal window background
rounded_rectangle(draw, 
    (terminal_x, terminal_y, terminal_x + terminal_width, terminal_y + terminal_height), 
    16, TERMINAL_BG)

# Terminal header bar
header_height = 40
draw.rectangle(
    [(terminal_x, terminal_y), (terminal_x + terminal_width, terminal_y + header_height)], 
    fill=(51, 51, 51, 255))

# Round the top corners of the header
draw.pieslice([(terminal_x, terminal_y), (terminal_x + 32, terminal_y + 32)], 180, 270, fill=(51, 51, 51, 255))
draw.pieslice([(terminal_x + terminal_width - 32, terminal_y), (terminal_x + terminal_width, terminal_y + 32)], 270, 360, fill=(51, 51, 51, 255))

# Window control dots
dot_y = terminal_y + 20
dot_colors = [
    (255, 95, 86, 255),   # Red
    (255, 189, 46, 255),  # Yellow
    (39, 201, 63, 255)    # Green
]
for i, color in enumerate(dot_colors):
    dot_x = terminal_x + 20 + i * 20
    draw.ellipse([(dot_x - 6, dot_y - 6), (dot_x + 6, dot_y + 6)], fill=color)

# Terminal prompt area
prompt_y = terminal_y + terminal_height // 2

# Try to load a monospace font
try:
    # Try different font paths
    font_paths = [
        "/System/Library/Fonts/Monaco.dfont",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Courier.dfont",
        "/Library/Fonts/Courier New.ttf",
    ]
    font = None
    for font_path in font_paths:
        if os.path.exists(font_path):
            try:
                font = ImageFont.truetype(font_path, 80)
                break
            except:
                continue
    if not font:
        font = ImageFont.load_default()
except:
    font = ImageFont.load_default()

# Draw the prompt >_
prompt_x = terminal_x + 60

# Draw > in light gray
draw.text((prompt_x, prompt_y), ">", fill=LIGHT_GRAY, font=font, anchor="lm")

# Draw _ (underscore/cursor) in Claude orange with slight offset
cursor_x = prompt_x + 70
draw.text((cursor_x, prompt_y + 5), "_", fill=CLAUDE_ORANGE, font=font, anchor="lm")

# Make cursor thicker by drawing it multiple times with slight offsets
for offset in [1, 2]:
    draw.text((cursor_x + offset, prompt_y + 5), "_", fill=CLAUDE_ORANGE, font=font, anchor="lm")

# Add subtle grid dots below to represent projects
grid_y = terminal_y + terminal_height + 40
dot_size = 8
dot_spacing = 24

# Center the grid
grid_width = 5 * dot_spacing
grid_start_x = (size - grid_width) // 2

for i in range(6):
    dot_x = grid_start_x + i * dot_spacing
    # Make first dot orange (active project)
    color = CLAUDE_ORANGE if i == 0 else (102, 102, 102, 180)
    draw.ellipse(
        [(dot_x - dot_size//2, grid_y - dot_size//2), 
         (dot_x + dot_size//2, grid_y + dot_size//2)], 
        fill=color)

# Save as PNG
os.makedirs('assets', exist_ok=True)
img.save('assets/icon.png')
print("Icon created: assets/icon.png")

# Create smaller versions
for size_variant in [256, 128, 64, 32, 16]:
    resized = img.resize((size_variant, size_variant), Image.Resampling.LANCZOS)
    resized.save(f'assets/icon_{size_variant}.png')
    print(f"Created: assets/icon_{size_variant}.png")

print("\nIcon features:")
print("- Terminal window with >_ prompt")
print("- > in light gray (#e0e0e0)")
print("- _ cursor in Anthropic orange (#EB8C55)")
print("- Background matches app (#1a1a1a)")
print("- Project dots below with first one highlighted")