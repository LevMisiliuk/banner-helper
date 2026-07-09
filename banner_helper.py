#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import itertools
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

try:
    import numpy as np
    from PIL import Image
except ModuleNotFoundError as exc:
    missing = exc.name or "dependency"
    print(
        f"Missing dependency: {missing}\n"
        "Install dependencies with:\n"
        "  python3 -m pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
class Slot:
    x: int
    y: int
    width: int
    height: int

    @property
    def area(self) -> int:
        return self.width * self.height


@dataclass(frozen=True)
class Job:
    parent: Path
    banner: Path


def image_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(p for p in path.iterdir() if p.suffix.lower() in IMAGE_EXTENSIONS)


def read_coords(path: Path) -> dict[str, Slot]:
    slots: dict[str, Slot] = {}
    with path.open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        required = {"parent", "x", "y"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV is missing columns: {', '.join(sorted(missing))}")

        for row in reader:
            parent = row["parent"].strip()
            width = int(row["width"]) if row.get("width") else 0
            height = int(row["height"]) if row.get("height") else 0
            slots[parent] = Slot(int(row["x"]), int(row["y"]), width, height)
    return slots


def find_components(mask: np.ndarray, min_pixels: int) -> list[Slot]:
    height, width = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    components: list[Slot] = []

    ys, xs = np.nonzero(mask)
    for start_x, start_y in zip(xs, ys, strict=False):
        if seen[start_y, start_x]:
            continue

        stack = [(int(start_x), int(start_y))]
        seen[start_y, start_x] = True
        min_x = max_x = int(start_x)
        min_y = max_y = int(start_y)
        pixels = 0

        while stack:
            x, y = stack.pop()
            pixels += 1
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)

            for next_x, next_y in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (
                    0 <= next_x < width
                    and 0 <= next_y < height
                    and not seen[next_y, next_x]
                    and mask[next_y, next_x]
                ):
                    seen[next_y, next_x] = True
                    stack.append((next_x, next_y))

        if pixels >= min_pixels:
            components.append(Slot(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))

    return components


def overlap_ratio(a: Slot, b: Slot) -> float:
    left = max(a.x, b.x)
    right = min(a.x + a.width, b.x + b.width)
    overlap = max(0, right - left)
    return overlap / max(1, min(a.width, b.width))


def merge_slots(slots: Iterable[Slot]) -> Slot:
    slots = list(slots)
    min_x = min(slot.x for slot in slots)
    min_y = min(slot.y for slot in slots)
    max_x = max(slot.x + slot.width for slot in slots)
    max_y = max(slot.y + slot.height for slot in slots)
    return Slot(min_x, min_y, max_x - min_x, max_y - min_y)


def group_vertical_banner_parts(components: list[Slot]) -> list[Slot]:
    candidates = [
        component
        for component in components
        if 70 <= component.width <= 260 and 35 <= component.height <= 700
    ]
    groups: list[list[Slot]] = []

    for component in sorted(candidates, key=lambda slot: (slot.x, slot.y)):
        placed = False
        for group in groups:
            union = merge_slots(group)
            gap = max(component.y - (union.y + union.height), union.y - (component.y + component.height), 0)
            if overlap_ratio(component, union) >= 0.65 and gap <= 170:
                group.append(component)
                placed = True
                break
        if not placed:
            groups.append([component])

    return [merge_slots(group) for group in groups]


def score_slot(slot: Slot, image_size: tuple[int, int]) -> float:
    image_width, image_height = image_size
    aspect = slot.width / max(slot.height, 1)
    target_aspect = 328 / 638
    aspect_score = max(0.0, 1.0 - abs(aspect - target_aspect) * 2.8)
    size_score = min(slot.area / 45000, 1.0)
    center_bias = 1.0 - min(abs((slot.x + slot.width / 2) - image_width / 2) / image_width, 0.5)
    top_penalty = 0.45 if slot.y < image_height * 0.12 else 1.0
    return aspect_score * 4 + size_score * 2 + center_bias + top_penalty


def detect_green_banner_slot(parent: Image.Image) -> Slot:
    rgb = parent.convert("RGB")
    arr = np.asarray(rgb)
    red = arr[:, :, 0].astype(np.int16)
    green = arr[:, :, 1].astype(np.int16)
    blue = arr[:, :, 2].astype(np.int16)

    mask = (green > 125) & (red < 95) & (blue < 95) & ((green - red) > 55) & ((green - blue) > 55)
    components = find_components(mask, min_pixels=500)
    slots = group_vertical_banner_parts(components)

    plausible = [
        slot
        for slot in slots
        if 90 <= slot.width <= 240
        and 170 <= slot.height <= 430
        and 0.35 <= slot.width / max(slot.height, 1) <= 0.7
    ]
    if not plausible:
        raise ValueError("Could not find a vertical green banner slot in this parent image.")

    return max(plausible, key=lambda slot: score_slot(slot, rgb.size))


def resolve_slot(parent: Image.Image, parent_path: Path, args: argparse.Namespace, coords: dict[str, Slot]) -> Slot:
    if coords:
        slot = coords.get(parent_path.name) or coords.get(str(parent_path))
        if not slot:
            raise ValueError(f"No CSV coordinates found for {parent_path.name}")
        if slot.width and slot.height:
            return slot
        return Slot(slot.x, slot.y, args.width or 0, args.height or 0)

    if args.x is not None and args.y is not None:
        width = args.width or 0
        height = args.height or 0
        return Slot(args.x, args.y, width, height)

    return detect_green_banner_slot(parent)


def prepare_banner(banner: Image.Image, slot: Slot, mode: str) -> Image.Image:
    if mode == "exact":
        return banner.convert("RGBA")

    if slot.width <= 0 or slot.height <= 0:
        raise ValueError("Width and height are required when mode is not exact.")

    banner = banner.convert("RGBA")
    if mode == "fit":
        return banner.resize((slot.width, slot.height), Image.Resampling.LANCZOS)

    if mode == "contain":
        result = Image.new("RGBA", (slot.width, slot.height), (255, 255, 255, 0))
        copy = banner.copy()
        copy.thumbnail((slot.width, slot.height), Image.Resampling.LANCZOS)
        x = (slot.width - copy.width) // 2
        y = (slot.height - copy.height) // 2
        result.alpha_composite(copy, (x, y))
        return result

    raise ValueError(f"Unknown mode: {mode}")


def paste_banner(parent_path: Path, banner_path: Path, output_path: Path, slot: Slot, mode: str) -> None:
    with Image.open(parent_path) as parent_image, Image.open(banner_path) as banner_image:
        parent = parent_image.convert("RGBA")
        banner = prepare_banner(banner_image, slot, mode)
        parent.alpha_composite(banner, (slot.x, slot.y))

        if parent_path.suffix.lower() in {".jpg", ".jpeg"}:
            parent.convert("RGB").save(output_path, quality=95, subsampling=0)
        else:
            parent.save(output_path)


def build_jobs(parents: list[Path], banners: list[Path], pairing: str) -> list[Job]:
    if pairing == "all":
        return [Job(parent, banner) for parent, banner in itertools.product(parents, banners)]

    if len(parents) != len(banners):
        raise ValueError("--pairing zip requires the same number of parent and banner images.")
    return [Job(parent, banner) for parent, banner in zip(parents, banners, strict=True)]


def safe_output_name(parent: Path, banner: Path, pairing: str) -> str:
    suffix = parent.suffix if parent.suffix.lower() in IMAGE_EXTENSIONS else ".png"
    if pairing == "zip":
        return f"{parent.stem}_with_banner{suffix}"
    return f"{parent.stem}__{banner.stem}{suffix}"


def run_batch(args: argparse.Namespace) -> int:
    parent_paths = image_files(Path(args.parents))
    banner_paths = image_files(Path(args.banners))
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not parent_paths:
        raise ValueError(f"No parent images found in {args.parents}")
    if not banner_paths:
        raise ValueError(f"No banner images found in {args.banners}")

    coords = read_coords(Path(args.coords)) if args.coords else {}
    jobs = build_jobs(parent_paths, banner_paths, args.pairing)
    detected_slots: dict[Path, Slot] = {}

    for job in jobs:
        with Image.open(job.parent) as parent_image:
            if job.parent not in detected_slots:
                detected_slots[job.parent] = resolve_slot(parent_image, job.parent, args, coords)
            slot = detected_slots[job.parent]

        output_path = output_dir / safe_output_name(job.parent, job.banner, args.pairing)
        paste_banner(job.parent, job.banner, output_path, slot, args.mode)
        print(f"Saved {output_path}  slot=({slot.x},{slot.y},{slot.width}x{slot.height})")

    print(f"Done: {len(jobs)} image(s).")
    return 0


def run_gui() -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title("Banner Helper")
    root.geometry("520x300")
    root.resizable(False, False)

    parents = tk.StringVar()
    banners = tk.StringVar()
    output = tk.StringVar(value=str(Path.cwd() / "results"))
    mode = tk.StringVar(value="fit")
    pairing = tk.StringVar(value="all")

    def pick_folder(variable: tk.StringVar) -> None:
        selected = filedialog.askdirectory()
        if selected:
            variable.set(selected)

    def start() -> None:
        if not parents.get() or not banners.get() or not output.get():
            messagebox.showerror("Missing folders", "Choose parent, banner, and output folders.")
            return

        ns = argparse.Namespace(
            parents=parents.get(),
            banners=banners.get(),
            output=output.get(),
            mode=mode.get(),
            pairing=pairing.get(),
            x=None,
            y=None,
            width=None,
            height=None,
            coords=None,
        )
        try:
            run_batch(ns)
        except Exception as exc:
            messagebox.showerror("Banner Helper", str(exc))
        else:
            messagebox.showinfo("Banner Helper", f"Done. Results are in:\n{output.get()}")

    frame = ttk.Frame(root, padding=18)
    frame.pack(fill="both", expand=True)

    for row, (label, variable) in enumerate(
        (("Parent screenshots", parents), ("Banner images", banners), ("Output folder", output))
    ):
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", pady=8)
        ttk.Entry(frame, textvariable=variable, width=46).grid(row=row, column=1, sticky="ew", padx=8)
        ttk.Button(frame, text="Choose", command=lambda v=variable: pick_folder(v)).grid(row=row, column=2)

    ttk.Label(frame, text="Paste mode").grid(row=3, column=0, sticky="w", pady=12)
    ttk.Combobox(frame, textvariable=mode, values=("fit", "contain", "exact"), state="readonly", width=12).grid(
        row=3, column=1, sticky="w", padx=8
    )

    ttk.Label(frame, text="Pairing").grid(row=4, column=0, sticky="w", pady=8)
    ttk.Combobox(frame, textvariable=pairing, values=("all", "zip"), state="readonly", width=12).grid(
        row=4, column=1, sticky="w", padx=8
    )

    ttk.Button(frame, text="Start", command=start).grid(row=5, column=1, sticky="e", pady=24)

    root.mainloop()
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replace banner images inside parent screenshots.")
    parser.add_argument("--parents", default="parents", help="Parent image file or folder.")
    parser.add_argument("--banners", default="banners", help="Banner image file or folder.")
    parser.add_argument("--output", default="results", help="Output folder.")
    parser.add_argument("--mode", choices=("fit", "contain", "exact"), default="fit")
    parser.add_argument("--pairing", choices=("all", "zip"), default="zip")
    parser.add_argument("--x", type=int, help="Manual x coordinate.")
    parser.add_argument("--y", type=int, help="Manual y coordinate.")
    parser.add_argument("--width", type=int, help="Manual slot width for fit/contain modes.")
    parser.add_argument("--height", type=int, help="Manual slot height for fit/contain modes.")
    parser.add_argument("--coords", help="CSV with parent,x,y,width,height columns.")
    parser.add_argument("--gui", action="store_true", help="Open a simple folder picker UI.")
    args = parser.parse_args(argv)

    if (args.x is None) ^ (args.y is None):
        parser.error("--x and --y must be passed together.")
    if args.mode != "exact" and args.x is not None and (args.width is None or args.height is None):
        parser.error("--width and --height are required with manual coordinates unless --mode exact is used.")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        if args.gui:
            return run_gui()
        return run_batch(args)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
