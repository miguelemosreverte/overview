#!/usr/bin/env python3
from PIL import Image, ImageDraw
import os

# Create a 512x512 icon
size = 512
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))  # Transparent background
draw = ImageDraw.Draw(img)

# Background - dark rounded square
def rounded_rectangle(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([(x0, y0 + radius), (x1, y1 - radius)], fill=fill)
    draw.rectangle([(x0 + radius, y0), (x1 - radius, y1)], fill=fill)
    draw.pieslice([(x0, y0), (x0 + 2 * radius, y0 + 2 * radius)], 180, 270, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y0), (x1, y0 + 2 * radius)], 270, 360, fill=fill)
    draw.pieslice([(x0, y1 - 2 * radius), (x0 + 2 * radius, y1)], 90, 180, fill=fill)
    draw.pieslice([(x1 - 2 * radius, y1 - 2 * radius), (x1, y1)], 0, 90, fill=fill)

# Main background
rounded_rectangle(draw, (32, 32, 480, 480), 48, (26, 26, 26, 255))

# Create 3x3 grid of project squares
grid_size = 3
square_size = 100
spacing = 24
start_x = (size - (grid_size * square_size + (grid_size - 1) * spacing)) // 2
start_y = (size - (grid_size * square_size + (grid_size - 1) * spacing)) // 2

for row in range(grid_size):
    for col in range(grid_size):
        x = start_x + col * (square_size + spacing)
        y = start_y + row * (square_size + spacing)
        
        # Highlight the top-left square (active project)
        if row == 0 and col == 0:
            # Glowing effect - draw multiple layers
            for glow in range(3):
                glow_size = square_size + (3 - glow) * 8
                glow_x = x - (glow_size - square_size) // 2
                glow_y = y - (glow_size - square_size) // 2
                alpha = 60 - glow * 20
                rounded_rectangle(draw, 
                    (glow_x, glow_y, glow_x + glow_size, glow_y + glow_size), 
                    12, (74, 158, 255, alpha))
            
            # Main active square
            rounded_rectangle(draw, (x, y, x + square_size, y + square_size), 8, (74, 158, 255, 255))
            
            # Inner glow effect
            inner_margin = 12
            rounded_rectangle(draw, 
                (x + inner_margin, y + inner_margin, 
                 x + square_size - inner_margin, y + square_size - inner_margin), 
                4, (107, 183, 255, 180))
        else:
            # Inactive squares
            rounded_rectangle(draw, (x, y, x + square_size, y + square_size), 8, (42, 42, 42, 255))
            
            # Subtle inner border
            inner_margin = 2
            rounded_rectangle(draw, 
                (x + inner_margin, y + inner_margin, 
                 x + square_size - inner_margin, y + square_size - inner_margin), 
                6, (51, 51, 51, 255))

# Add small indicator dots in the active square (representing terminal, preview, etc)
active_x = start_x
active_y = start_y
dot_y = active_y + square_size - 20

for i in range(3):
    dot_x = active_x + 25 + i * 25
    draw.ellipse([(dot_x - 4, dot_y - 4), (dot_x + 4, dot_y + 4)], 
                 fill=(255, 255, 255, 200 if i == 1 else 120))

# Save as PNG
os.makedirs('assets', exist_ok=True)
img.save('assets/overview_icon.png')
print("Icon created: assets/overview_icon.png")

# Create smaller versions
for size_variant in [256, 128, 64, 32, 16]:
    resized = img.resize((size_variant, size_variant), Image.Resampling.LANCZOS)
    resized.save(f'assets/overview_icon_{size_variant}.png')
    print(f"Created: assets/overview_icon_{size_variant}.png")

# Also save as the main icon.png
img.save('assets/icon.png')
print("Updated: assets/icon.png")