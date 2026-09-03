/**
 * Skills: reference the model loads when it changes what it will do next. The
 * system prompt lists them in a line each and stays a short, cacheable
 * prefix; the detail — every font style, the view grammar, the parts on
 * screen with their colours, how to read a report — arrives only in a session
 * that asks. Carried in-band as a ```skill block, like a view request. The
 * body is rendered at window time, so a listing is always current.
 */
import { FONT_FILES } from '../kernel/fonts'
import type { Mesh } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import { describeColours, partColourShares } from '../viewer/select'
import { CLOSE_FENCE, OPEN_FENCE, SKILL_FENCE } from './fence'
import { partSections } from './parts'
import { VIEW_SHAPE } from './views'

export const SKILLS = [
  { name: 'fonts', what: 'the faces text() has, every style by name, and how to size and cut printed lettering' },
  { name: 'views', what: 'looking at the part: named views, cuts, framing a box, close-ups of what changed, the best side' },
  { name: 'parts', what: 'the parts of this document listed with their colours, and how to replace, add, delete or edit one' },
  { name: 'diff', what: 'reading the measured report and the green/magenta render after a compile' },
  { name: 'bosl2', what: 'the BOSL2 library: rounded and chamfered primitives, anchors, threads, gears, screw holes' },
] as const

export type SkillName = (typeof SKILLS)[number]['name']
export const SKILL_NAMES: readonly string[] = SKILLS.map((s) => s.name)
export const isSkill = (name: string): name is SkillName => SKILL_NAMES.includes(name)

/** The last ```skill block of a reply: its first word, lowercased. */
export function parseSkill(text: string): { name: string | null; complete: boolean } {
  let body: string[] | null = null
  let last: string | null = null
  let skipping = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (body === null && !skipping) {
      if (SKILL_FENCE.test(line)) body = []
      else if (OPEN_FENCE.test(line)) skipping = true
    } else if (CLOSE_FENCE.test(line)) {
      if (body !== null) last = body.join('\n')
      body = null
      skipping = false
    } else if (body !== null) body.push(line)
  }
  const name = last?.trim().split(/\s+/)[0]?.toLowerCase() ?? null
  return { name: name || null, complete: body === null }
}

export interface SkillContext {
  /** The source the model is shown. */
  source: string
  /** The latest mesh — this turn's compile, else the part on screen. null when nothing has compiled. */
  mesh: Mesh | null
  /** Whether looks are allowed this session (thinking on). */
  looks: boolean
}

export function renderSkill(name: string, ctx: SkillContext): string | null {
  switch (name) {
    case 'fonts':
      return fontsSkill()
    case 'views':
      return viewsSkill(ctx.looks)
    case 'parts':
      return partsSkill(ctx.source, ctx.mesh)
    case 'diff':
      return DIFF_SKILL
    case 'bosl2':
      return BOSL2_SKILL
    default:
      return null
  }
}

const spaced = (camel: string): string => camel.replace(/([a-z])([A-Z])/g, '$1 $2')

/** Generated from the vendored files, so the list can never promise a face that is not there. */
function fontsSkill(): string {
  const families = new Map<string, string[]>()
  for (const file of FONT_FILES) {
    const [family = '', style = ''] = file.replace(/\.ttf$/, '').split('-')
    const name = spaced(family)
    families.set(name, [...(families.get(name) ?? []), spaced(style)])
  }
  const rows = [...families].map(
    ([family, styles]) => `- "${family}"${family === 'Liberation Sans' ? ' (the default)' : ''}: ${styles.join(', ')}`,
  )
  return `# Fonts

text() has exactly these faces. Nothing else is installed, and any other name silently gets the nearest of them:
${rows.join('\n')}

Name a face as font = "Family:style=Style" — font = "Liberation Serif:style=Bold Italic". A bare family name is its Regular.

text(t, size = 10, font, halign = "left" | "center" | "right", valign = "baseline" | "top" | "center" | "bottom", spacing = 1, direction = "ltr") is 2D on the XY plane, the baseline on the X axis. size sets the ascent: capitals come out about 0.7 × size tall, and n characters of Sans run roughly 0.55 × size × n wide. Those are estimates for placing it; the report measures the result.

Printed lettering: size 5 mm or more, so strokes clear 0.8 mm; relief 0.8 to 1.5 mm. $fn from the top of the file shapes the glyph curves.
Lettering gets its own colour, always — a second filament prints it, and the report and the listing name it by that colour. Emboss — raised on a top face at z = h, in a colour other than the base's:
    color("gold") translate([0, 0, h]) linear_extrude(relief)
      text("Biergarten", size = 8, font = "Liberation Serif:style=Bold", halign = "center", valign = "center");
Engrave — cut into that face; the cut faces take the cutter's colour, so colouring the cutter colours the engraving:
    difference() {
      color("saddlebrown") body();
      color("ivory") translate([0, 0, h - depth]) linear_extrude(depth + 1)
        text("Biergarten", size = 8, font = "Liberation Serif:style=Bold", halign = "center", valign = "center");
    }
Lettering on a wall is rotated into the wall's plane first (rotate([90, 0, 0]) for a face on -Y); lettering read from below is mirror([1, 0, 0])-ed, or it prints backwards.`
}

function viewsSkill(looks: boolean): string {
  if (!looks) {
    return `# Views

Thinking is off in this session, so looks are unavailable: a reply that is only a view request is refused, and a compiled source is committed without a report or a render. The user turns looks on with /think low, medium or high, or in the settings.`
  }
  return `# Views

After a source compiles you get a measured report and a render (the diff skill reads them). To see more, reply with ONLY a \`\`\`view block — no source beside it — whose body is one JSON object:
    \`\`\`view
    {"view": "front", "section": {"axis": "z", "at": 12}, "box": null, "closeup": null}
    \`\`\`
${VIEW_SHAPE}

- view — where the camera stands. iso: from +X −Y +Z, the front-right, above. iso_back: the opposite corner. front: from −Y. back: from +Y. right: from +X. left: from −X. top and bottom: along Z. auto: the app picks the side the box — or the whole part, when box is null — is best seen from: the octant of its part it sits in, so a hole in a top face is seen from above and a wheel under a wing from below.
- section — a cut at one coordinate on x, y or z. The half nearer the camera is removed and the cut face shows darker, so the inside shows: a pocket, a bore, a wall thickness.
- box — frame this box, in millimetres, instead of the whole part. Take it from the report (per_part, changed_pieces, changed_bbox_mm); framing empty space is the usual mistake.
- closeup — a number from the last report's changed_pieces: a green/magenta close-up of that piece from its best side (its seen_from). The other fields are then ignored. When the largest changed piece is small against its part, the composite's right pane already shows it as piece 1.

Every look is a round trip the user waits for: ask only when the answer changes what you will do next, and say in one line what you are checking. Read every dimension from the report, never from a picture — a render shows layout and proportion only.`
}

const num = (n: number): string => String(Math.round(n * 10) / 10)
const vec = (v: readonly number[]): string => `[${v.map(num).join(', ')}]`

/** The parts on screen against the PART sections in the source, one line each, colour first. */
export function listParts(source: string, mesh: Mesh | null): string {
  const sections = partSections(source)
  const stats = mesh ? meshStats(mesh) : null
  const solids = stats?.shells ?? []
  const colours = mesh ? partColourShares(mesh).map(describeColours) : []
  const n = Math.max(sections.length, solids.length)
  if (n === 0) return 'No PART sections in the source, and nothing on screen.'
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const section = sections[i]
    const solid = solids[i]
    const call = section ? `\`${section.call || '(no call)'}\`` : 'no PART section — an extra solid'
    const colour = colours[i] ?? 'no colour'
    const where = solid
      ? `${solid.size.map(num).join(' × ')} mm, from ${vec(solid.min)} to ${vec(solid.max)}`
      : mesh
        ? 'nothing on screen for it'
        : 'not compiled yet'
    lines.push(`${i + 1}. ${call} — ${colour}; ${where}`)
  }
  const head = `${sections.length} PART section${sections.length === 1 ? '' : 's'} in the source, ${
    mesh ? `${solids.length} solid${solids.length === 1 ? '' : 's'} on screen` : 'nothing compiled yet'
  }.`
  const mismatch =
    mesh && solids.length > sections.length
      ? ' More solids than sections: a part is in disconnected pieces, or a call sits outside the sections.'
      : mesh && solids.length < sections.length
        ? ' Fewer solids than sections: two parts touch or overlap and fused, or a section produces nothing.'
        : ''
  return `${head}${mismatch}\n${lines.join('\n')}`
}

function partsSkill(source: string, mesh: Mesh | null): string {
  return `# Parts

A part is one top-level call inside a PART section. Part N in the viewport is PART N in the source, and a click selects one by number — the message then opens with [Selected part N of M: …].
    // ---- PART 2 ----
    module lid() { ... }
    color("red") translate([60, 0, 0]) lid();
    // ---- PART 2 END ----
Colour is a print instruction and a name at once: give each part a colour when there are several, and inside a part give every feature a second filament would print — lettering, a logo, an inlay, trim — its own color(), the base another. Colours survive union and difference (a cut face takes the cutter's colour, so colouring the cutter colours an engraving) and export to 3MF as materials. The listing below names each part by its colours, so the user and you can say "the gold lettering". Parts sit on Z=0 on their print face, 5 mm apart, never overlapping: top-level calls are not unioned, and two that touch print as two bodies.

Changing parts, smallest change first:
- openscad-edit — a few lines anywhere: SEARCH lines copied exactly, occurring once; REPLACE with the new lines.
- openscad-part N — the section's new lines, markers excluded; replaces PART N whole. One past the last number adds a part; an empty body deletes one, and the rest renumber.
- openscad-part name — the whole new \`module name(...) { … }\`; replaces that module wherever it is, and an unknown name appends one.
- the complete source — only when most of the file changes.
Parameters, $fn and shared modules stay above the first marker; a module only one part uses lives in its section. A section with no call puts nothing on screen; a call outside every section shifts the numbering.

## The parts of this document
${listParts(source, mesh)}`
}

const DIFF_SKILL = `# Reading a report

After every compile the app measures the mesh and sends numbers (millimetres, mm³), then its own verdicts, then a render.

The report:
- model_bbox_mm, volume_mm3, watertight, tri_count — the whole mesh.
- parts, per_part — the solids in PART order, each with its box and volume. A moved_mm entry means that part was translated whole by that vector since the previous round; the move is already taken out of everything below, so only a change of shape registers.
- voids — closed cavities: a pocket or hole whose cutter never reached a surface, sealed inside the part. Extend the cutter past the outer face.
- genus — through-holes and loops in the mesh (a ring is 1, a plate with four bolt holes is 4). A jump means holes or loops appeared; make sure they were meant.
- was — the same figures for the previous round, or null on the first.
- changed_bbox_mm, added_volume_mm3, removed_volume_mm3 — the difference between the previous round and this one. Hair-thin slivers where the two compiles triangulated a face differently count in the volumes and are ignored for the boxes.
- changed_pieces — each connected piece of that difference, largest first: its kind (added or removed), box, volume and seen_from, the side it is best seen from. Its number is what a view request's closeup takes.

Checks the app ran: rests on Z=0 per part, solids against the PART sections, voids, watertight, genus. A line marked NO is a defect, it names the part or the piece, and the fix is in the source you can see. They are settled; do not re-ask them. Your own questions go to the request.

The render: one orthographic view framed on what changed — the previous version in green, this version in magenta, unchanged material in grey, crease outlines — and, when the largest changed piece is small against its part, a second pane close up on it from its best side. Green alone is material that went away; magenta alone is material that appeared; a part moved whole is put back before the comparison, so a move shows as nothing. Layout and proportion only: every dimension comes from the numbers.

Each round is measured against the round before it — the first against the part on screen when the turn began — so a correction's report and render show the correction, not the whole turn. One sentence with no code block confirms the part and keeps the source as it is; a correction is an openscad-edit for a few lines, an openscad-part block for a whole part or module, or the complete source when most of the file changes.`

const BOSL2_SKILL = `# BOSL2

\`include <BOSL2/std.scad>\` at the top of the file, after the title comment and before the parameters. Every include is parsed on each compile, so include only what the part uses. Sizes are millimetres; every primitive takes anchor= (BOTTOM, TOP, CENTER, LEFT, FRONT+LEFT+BOTTOM …), spin= and orient=. anchor=BOTTOM puts the part on Z=0, which is where it must sit.

Primitives, std.scad:
- cuboid([x, y, z], rounding=r, chamfer=c, edges=..., except=..., anchor=BOTTOM) — a box with rounded or chamfered edges. edges="Z" rounds the vertical edges only; except=BOTTOM leaves the print face sharp.
- cyl(h=, d=|r=, rounding1=, rounding2=, chamfer1=, chamfer2=, anchor=BOTTOM) — a cylinder with rounded or chamfered ends; d1= and d2= taper it.
- tube(h=, od=, id=|wall=, anchor=BOTTOM) — a hollow cylinder. prismoid(size1=[x, y], size2=[x, y], h=, rounding=) — a truncated pyramid.
- rect([x, y], rounding=r) and ellipse(d=) — 2D shapes for linear_extrude() and offset().
- xrot(), yrot(), zrot(), up(), down(), left(), right(), fwd(), back(), move([x, y, z]) — transforms that read as words.
- xcopies(spacing, n), ycopies(), grid_copies(spacing, n=[nx, ny]), zrot_copies(n) — distributed copies, for hole patterns.
- diff() { cuboid(...); tag("remove") cyl(...); } — a difference where the cutter is tagged; attach() places children on faces.

Threads, threading.scad: threaded_rod(d=, l=, pitch=), threaded_nut(nutwidth=, id=, h=, pitch=). Gears, gears.scad: spur_gear(mod=, teeth=, thickness=), rack(). Screw holes, screws.scad: screw_hole("M3", l=, head="flat", anchor=TOP).

Example, a rounded box with four M3 holes:
    include <BOSL2/std.scad>
    diff() cuboid([60, 40, 8], rounding = 3, except = BOTTOM, anchor = BOTTOM)
      grid_copies(spacing = [50, 30]) tag("remove") position(TOP) cyl(h = 20, d = 3.4, anchor = CENTER);

The library is large; a wrong argument name is a compile error you will see and can fix. When in doubt, plain OpenSCAD primitives compile faster and are just as printable.`
