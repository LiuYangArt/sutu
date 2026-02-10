import os
import sys
from PIL import Image

def process_icon(source_path, target_dir_tauri, target_dir_public):
    if not os.path.exists(source_path):
        print(f"Error: Source file not found at {source_path}")
        return

    # Ensure directories exist
    os.makedirs(target_dir_tauri, exist_ok=True)
    os.makedirs(target_dir_public, exist_ok=True)

    img = Image.open(source_path)

    # Resize and save for src-tauri/icons
    sizes = {
        "icon.png": (512, 512),
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50), # Approximate, usually handled by store
    }

    print(f"Processing icons from {source_path}...")

    for name, size in sizes.items():
        resized = img.resize(size, Image.Resampling.LANCZOS)
        resized.save(os.path.join(target_dir_tauri, name))
        print(f"Saved {name} ({size})")

    # Generate ICO (multi-size)
    ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    img.save(os.path.join(target_dir_tauri, "icon.ico"), format='ICO', sizes=ico_sizes)
    print("Saved icon.ico")

    # Public folder (favicons mainly, but Tauri uses public sometimes for webview)
    # Using 192x192 as a standard favicon/pwa icon size, or just copying the large one?
    # Let's verify what's currently there. Based on the list, there's icon.png and webview-latency-test.html
    # We'll just put a nice 512x512 icon.png there.
    img.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(target_dir_public, "icon.png"))
    print("Saved public/icon.png")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python process_icons.py <path_to_source_image>")
        sys.exit(1)

    source_image = sys.argv[1]
    # Paths relative to project root assuming script is run from project root or checks paths
    project_root = os.getcwd() # Assumption: run from project root
    tauri_icons_dir = os.path.join(project_root, "src-tauri", "icons")
    public_dir = os.path.join(project_root, "public")

    process_icon(source_image, tauri_icons_dir, public_dir)
