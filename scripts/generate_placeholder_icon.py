
import math
from PIL import Image, ImageDraw

def create_gradient_icon(output_path, size=1024):
    # Create image with transparent background
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # 1. Background: Dark rounded rectangle (almost squircle)
    bg_color = (20, 20, 25) # Dark slate/black
    corner_radius = size // 5

    # Draw rounded rectangle manually or use a shape
    # Since we want a nice shape, let's just fill a rounded rect
    draw.rounded_rectangle([(0, 0), (size, size)], radius=corner_radius, fill=bg_color)

    # 2. Key visual: stylized P/B or brush stroke
    # Let's do a colorful abstract curve/stroke

    # Gradient colors
    c1 = (0, 198, 255) # Electric Blue
    c2 = (140, 50, 255) # Purple
    c3 = (255, 30, 150) # Pink

    # We'll draw a series of circles to simulate a gradient stroke
    # A simple "S" or wave shape

    points = []
    steps = 200

    # Wave parameters
    margin = size * 0.2
    width = size - 2 * margin
    height = size - 2 * margin

    for i in range(steps):
        t = i / (steps - 1)
        # S-curve
        x = margin + width * t
        y = size/2 + math.sin(t * math.pi * 2) * (height * 0.3)

        # Interpolate color
        if t < 0.5:
            # c1 to c2
            local_t = t * 2
            r = int(c1[0] + (c2[0] - c1[0]) * local_t)
            g = int(c1[1] + (c2[1] - c1[1]) * local_t)
            b = int(c1[2] + (c2[2] - c1[2]) * local_t)
        else:
            # c2 to c3
            local_t = (t - 0.5) * 2
            r = int(c2[0] + (c3[0] - c2[0]) * local_t)
            g = int(c2[1] + (c3[1] - c2[1]) * local_t)
            b = int(c2[2] + (c3[2] - c2[2]) * local_t)

        color = (r, g, b, 255)

        # Variable thickness
        thickness = (size * 0.15) * (1 - 0.5 * abs(t - 0.5))

        # Draw circle at point
        rO = thickness / 2
        draw.ellipse([x - rO, y - rO, x + rO, y + rO], fill=color)

    # Add a glass highlight
    highlight_color = (255, 255, 255, 20)
    draw.ellipse([size*0.1, size*0.1, size*0.9, size*0.5], fill=highlight_color)

    image.save(output_path)
    print(f"Generated icon at {output_path}")

if __name__ == "__main__":
    create_gradient_icon("icon_master.png")
