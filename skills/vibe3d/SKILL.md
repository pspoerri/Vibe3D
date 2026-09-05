---
name: vibe3d
description: Design a 3D-printable part in OpenSCAD with measured feedback — compile, check printability, look at renders, export 3MF/STL/OBJ for a slicer. Use when asked to model, design or print a part, bracket, mount, case, holder, knob, or any physical object.
---

# Vibe3D

The Vibe3D app's design loop, from the shell. Every command below is `<this skill's directory>/vibe3d …` — the directory this file is in. Needs `bun` on PATH; `look` also needs Chrome or Chromium, found on PATH or named by `VIBE3D_CHROME`. Everything else is in this directory.

## The loop

1. **Once per session:** run `vibe3d prompt` and follow it. It is the app's modelling rules — file structure, PART sections, printability, colour, BOSL2, fonts — and its skills. Write the source to a `.scad` file.
2. **Check:** `vibe3d check part.scad`. It prints the measured report (bounding box, volume, parts, genus, per-part colours and overhangs) and the app's checks. Fix every line marked `NO` and every note under "Notes on the source" before anything else. A compile error prints the kernel's line: fix it and check again.
3. **Verify against the request:** write 2 to 5 yes/no questions the request implies — the features it named, their sizes, where they sit relative to each other — and answer each from the report with one line of reasoning. Read every dimension from the report, never from a picture.
4. **Look when a number cannot answer:** `vibe3d look part.scad view.png --view front --cut z=12`, then Read the PNG. Views: `iso`, `iso_back`, `front`, `back`, `left`, `right`, `top`, `bottom`, `auto` (the best side of `--box`); `--cut axis=mm` removes the half nearer the camera; `--box x0,y0,z0,x1,y1,z1` frames a region. Construction geometry shows as a blue ghost.
5. **After a change**, keep a copy of the previous file and compare: `vibe3d check part.scad --before previous.scad` adds what was added and removed, largest pieces first, each with the side it is best seen from; `vibe3d look part.scad diff.png --before previous.scad` shows the previous version in green over the new one in magenta, unchanged material grey, with a close-up pane of the largest change when it is small — the image is then 1536 × 768, two panes side by side.
6. **Export:** `vibe3d export part.scad part.3mf` for the slicer — one object per part, colours as materials. `.stl` or `.obj` when asked; `--part N` writes one part alone.

Iterate 2 → 5 until every check is yes and every answer is yes. Then export.

## Commands

| Command | Does |
|---|---|
| `vibe3d check part.scad [--before prev.scad] [--bed X,Y,Z]` | Report and checks; `--bed` is the printer's build volume in mm (default 256,256,256) |
| `vibe3d export part.scad out.3mf\|.stl\|.obj [--part N]` | Writes the file; OBJ gets an `.mtl` beside it when coloured |
| `vibe3d look part.scad out.png [--view V] [--cut a=mm] [--box …] [--before prev.scad]` | A PNG, 768 px; with `--before` the green/magenta composite, and `--view`, `--cut` and `--box` are validated but do nothing |
| `vibe3d prompt` | The modelling rules and skills |

Files named by `import("name.stl")` in the source are read from beside the `.scad` file.
